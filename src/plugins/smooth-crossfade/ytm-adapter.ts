import type {
  ItemPlaylistPanelVideoRenderer,
  QueueItem,
} from '@/types/datahost-get-state';
import type { MusicPlayer } from '@/types/music-player';
import type { QueueElement } from '@/types/queue';

/**
 * Everything that touches YouTube Music's DOM, queue or player lives here, so
 * changes on their side only need fixes in this file.
 */

type QueueEntry = {
  /** The audio version's ID. */
  videoId: string;
  /** The music-video version's ID, when the song has both. */
  counterpartId: string | null;
  selected: boolean;
  albumId: string | null;
};

/** Album pages have browse IDs starting with `MPREb_`; the byline links to one. */
const albumIdOf = (renderer: ItemPlaylistPanelVideoRenderer) => {
  for (const run of renderer.longBylineText?.runs ?? []) {
    const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
    if (browseId?.startsWith('MPREb_')) return browseId;
  }
  return null;
};

const unwrap = (item: QueueItem): QueueEntry | null => {
  if (item.playlistPanelVideoRenderer) {
    const renderer = item.playlistPanelVideoRenderer;
    return {
      videoId: renderer.videoId,
      counterpartId: null,
      selected: !!renderer.selected,
      albumId: albumIdOf(renderer),
    };
  }

  const wrapper = item.playlistPanelVideoWrapperRenderer;
  if (!wrapper) return null;

  const primary = wrapper.primaryRenderer.playlistPanelVideoRenderer;
  const counterpart =
    wrapper.counterpart[0]?.counterpartRenderer.playlistPanelVideoRenderer;
  return {
    videoId: primary.videoId,
    counterpartId: counterpart?.videoId ?? null,
    selected: !!primary.selected || !!counterpart?.selected,
    albumId: albumIdOf(primary),
  };
};

export const getVideoElement = () =>
  document.querySelector<HTMLVideoElement>('video');

export const getProgressBar = () =>
  document.querySelector<HTMLElement>('ytmusic-player-bar #progress-bar');

export type QueueContext = {
  currentId: string | null;
  nextId: string | null;
  currentAlbumId: string | null;
  nextAlbumId: string | null;
};

const EMPTY_QUEUE: QueueContext = {
  currentId: null,
  nextId: null,
  currentAlbumId: null,
  nextAlbumId: null,
};

/**
 * Where the playing song is in the queue and what follows it. The player's
 * video ID is the authority on what's playing; the queue's `selected` flag can
 * lag behind it, so it's only a fallback.
 */
export const getQueueContext = (playingId: string | null): QueueContext => {
  const items = document
    .querySelector<QueueElement>('#queue')
    ?.queue.getItems();
  if (!items) return EMPTY_QUEUE;

  const entries = items.map(unwrap).filter((e) => e !== null);
  let index = entries.findIndex(
    (e) => e.videoId === playingId || e.counterpartId === playingId,
  );
  if (index === -1) index = entries.findIndex((e) => e.selected);
  if (index === -1) return EMPTY_QUEUE;

  const current = entries[index];
  const next = entries[index + 1];
  // Playing the music-video version means YT Music is in video mode, so it
  // will play the next song's video version too (when there is one).
  const videoMode = playingId !== null && playingId === current.counterpartId;
  const nextId = next
    ? ((videoMode ? next.counterpartId : null) ?? next.videoId)
    : null;

  return {
    currentId: playingId ?? current.videoId,
    nextId,
    currentAlbumId: current.albumId,
    nextAlbumId: next?.albumId ?? null,
  };
};

/**
 * Song position and identity. These come from the player API, not the
 * <video> element: in gapless playback YT Music appends the next song to the
 * same media stream, so the element's clock keeps counting from the previous
 * song and no `loadstart` fires on the track change.
 */
export type PlayerAdapter = {
  /** Current song's video ID. */
  videoId: () => string | null;
  /** Position in the current song (s). */
  position: () => number;
  /** Current song's length (s), from its metadata. */
  duration: () => number | null;
  seekTo: (seconds: number) => void;
  next: () => void;
};

export const createPlayerAdapter = (
  getApi: () => MusicPlayer | undefined,
  video: HTMLMediaElement,
): PlayerAdapter => ({
  videoId: () => getApi()?.getPlayerResponse()?.videoDetails.videoId ?? null,
  position: () => getApi()?.getCurrentTime() ?? video.currentTime,
  duration: () => {
    const length = Number(
      getApi()?.getPlayerResponse()?.videoDetails.lengthSeconds,
    );
    return Number.isFinite(length) && length > 0 ? length : null;
  },
  seekTo: (seconds) => {
    const api = getApi();
    if (api) api.seekTo(seconds);
    else video.currentTime = seconds;
  },
  next: () => getApi()?.nextVideo(),
});
