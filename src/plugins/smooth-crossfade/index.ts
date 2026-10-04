import { Innertube } from 'youtubei.js';

import { t } from '@/i18n';
import { getNetFetchAsFetch } from '@/plugins/utils/main';
import { createPlugin } from '@/utils';

import {
  CrossfadeEngine,
  DEFAULT_ENGINE_SETTINGS,
  type IncomingAudio,
} from './engine';
import { SeekbarOverlay } from './overlay';
import { getVideoElement } from './ytm-adapter';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

const HEAD_BYTES = 1024 * 1024;

export type SmoothCrossfadePluginConfig = {
  enabled: boolean;
  /** 'auto' picks beat-match, echo-out or crossfade for each pair. */
  style: 'auto' | 'crossfade';
  /** Largest tempo change for beat-matching, as a fraction (0 = off). */
  maxTempoChange: number;
  blendBeats: 'auto' | 8 | 16 | 32;
  bassSwap: boolean;
  harmonicMixing: boolean;
  /** Start blends on the incoming song's first steady downbeat. */
  skipIntros: boolean;
  /** Start blends on an outgoing phrase (8-bar section) boundary. */
  phraseMixing: boolean;
  /** Crossfade length in seconds. */
  fadeDuration: number;
  /** No transition between consecutive tracks of the same album. */
  skipSameAlbum: boolean;
  /** Show the transition overlay when hovering the seekbar. */
  showOverlay: boolean;
  /** Detailed console logs and a `window.smoothCrossfade` handle. */
  debug: boolean;
};

const FADE_DURATIONS = [3, 4, 5, 6, 8, 10, 12];
const TEMPO_CHANGES = [0, 0.03, 0.06, 0.1];
const BLEND_LENGTHS = ['auto', 8, 16, 32] as const;

export default createPlugin<
  unknown,
  unknown,
  {
    config?: SmoothCrossfadePluginConfig;
    ipc?: RendererContext<SmoothCrossfadePluginConfig>['ipc'];
    playerApi?: MusicPlayer;
    engine?: CrossfadeEngine;
    overlay?: SeekbarOverlay;
    updateOverlay?: () => void;
    updateDebugHandle?: () => void;
    audioCanPlay?: (event: CustomEvent<Compressor>) => void;
  },
  SmoothCrossfadePluginConfig
>({
  name: () => t('plugins.smooth-crossfade.name'),
  description: () => t('plugins.smooth-crossfade.description'),
  // The audio graph has to be installed before other audio plugins attach.
  restartNeeded: true,
  config: {
    enabled: false,
    style: 'auto',
    maxTempoChange: 0.06,
    blendBeats: 'auto',
    bassSwap: true,
    harmonicMixing: true,
    skipIntros: true,
    phraseMixing: true,
    fadeDuration: 6,
    skipSameAlbum: true,
    showOverlay: true,
    debug: false,
  },

  async menu({ getConfig, setConfig }) {
    const config = await getConfig();

    const menuKey = 'plugins.smooth-crossfade.menu';
    return [
      {
        label: t(`${menuKey}.style.label`),
        submenu: (['auto', 'crossfade'] as const).map((style) => ({
          label: t(`${menuKey}.style.${style}`),
          type: 'radio',
          checked: config.style === style,
          click() {
            setConfig({ style });
          },
        })),
      },
      {
        label: t(`${menuKey}.max-tempo-change.label`),
        submenu: TEMPO_CHANGES.map((change) => ({
          label:
            change === 0
              ? t(`${menuKey}.max-tempo-change.off`)
              : t(`${menuKey}.max-tempo-change.percent`, {
                  percent: Math.round(change * 100),
                }),
          type: 'radio',
          checked: config.maxTempoChange === change,
          click() {
            setConfig({ maxTempoChange: change });
          },
        })),
      },
      {
        label: t(`${menuKey}.blend-length.label`),
        submenu: BLEND_LENGTHS.map((beats) => ({
          label:
            beats === 'auto'
              ? t(`${menuKey}.blend-length.auto`)
              : t(`${menuKey}.blend-length.beats`, { beats }),
          type: 'radio',
          checked: config.blendBeats === beats,
          click() {
            setConfig({ blendBeats: beats });
          },
        })),
      },
      {
        label: t(`${menuKey}.bass-swap`),
        type: 'checkbox',
        checked: config.bassSwap,
        click(item) {
          setConfig({ bassSwap: item.checked });
        },
      },
      {
        label: t(`${menuKey}.harmonic-mixing`),
        type: 'checkbox',
        checked: config.harmonicMixing,
        click(item) {
          setConfig({ harmonicMixing: item.checked });
        },
      },
      {
        label: t(`${menuKey}.phrase-mixing`),
        type: 'checkbox',
        checked: config.phraseMixing,
        click(item) {
          setConfig({ phraseMixing: item.checked });
        },
      },
      {
        label: t(`${menuKey}.skip-intros`),
        type: 'checkbox',
        checked: config.skipIntros,
        click(item) {
          setConfig({ skipIntros: item.checked });
        },
      },
      { type: 'separator' },
      {
        label: t('plugins.smooth-crossfade.menu.fade-duration.label'),
        submenu: FADE_DURATIONS.map((seconds) => ({
          label: t('plugins.smooth-crossfade.menu.fade-duration.seconds', {
            seconds,
          }),
          type: 'radio',
          checked: config.fadeDuration === seconds,
          click() {
            setConfig({ fadeDuration: seconds });
          },
        })),
      },
      {
        label: t('plugins.smooth-crossfade.menu.skip-same-album'),
        type: 'checkbox',
        checked: config.skipSameAlbum,
        click(item) {
          setConfig({ skipSameAlbum: item.checked });
        },
      },
      {
        label: t('plugins.smooth-crossfade.menu.show-overlay'),
        type: 'checkbox',
        checked: config.showOverlay,
        click(item) {
          setConfig({ showOverlay: item.checked });
        },
      },
      {
        label: t(`${menuKey}.debug`),
        type: 'checkbox',
        checked: config.debug,
        click(item) {
          setConfig({ debug: item.checked });
        },
      },
    ];
  },

  async backend({ ipc }) {
    const yt = await Innertube.create({ fetch: getNetFetchAsFetch() });

    // Stream URLs only serve their first ~1 MiB to clients without a PO
    // token (anything beyond gets 403). The shadow player only needs the
    // start of the incoming song, so fetch that head here and hand it over.
    ipc.handle(
      'smooth-crossfade:audio-head',
      async (videoId: string): Promise<IncomingAudio | undefined> => {
        const info = await yt.getBasicInfo(videoId, { client: 'IOS' });
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });
        const url = format.url ?? (await format.decipher(yt.session.player));
        if (!url) return undefined;

        const response = await fetch(url, {
          headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
        });
        if (!response.ok) {
          throw new Error(`audio head request failed: ${response.status}`);
        }

        const data = new Uint8Array(await response.arrayBuffer());
        return {
          data,
          mime: format.mime_type.split(';')[0],
          seconds: (data.byteLength * 8) / (format.bitrate || 128_000),
        };
      },
    );
  },

  renderer: {
    async start({ ipc, getConfig }) {
      this.config = await getConfig();
      this.ipc = ipc;

      // In debug mode the engine is reachable from DevTools.
      this.updateDebugHandle = () => {
        const target = window as { smoothCrossfade?: CrossfadeEngine };
        if (this.config?.debug && this.engine)
          target.smoothCrossfade = this.engine;
        else delete target.smoothCrossfade;
      };

      this.updateOverlay = () => {
        const wanted = Boolean(this.engine && this.config?.showOverlay);
        if (wanted && !this.overlay && this.engine) {
          const engine = this.engine;
          this.overlay = new SeekbarOverlay(() => engine.getOverlaySnapshot());
          this.overlay.start();
        } else if (!wanted && this.overlay) {
          this.overlay.stop();
          this.overlay = undefined;
        }
      };

      // The app shares one AudioContext / source node for the <video>;
      // reuse them (a media element can only have one source node).
      // Capture phase: runs before other plugins' listeners on the same
      // event, so the audio graph is in place before they attach to it.
      this.audioCanPlay = ({ detail: { audioContext, audioSource } }) => {
        if (this.engine) return;
        const video = getVideoElement();
        if (!video) return;

        this.engine = new CrossfadeEngine({
          audioContext,
          mainSource: audioSource,
          video,
          getPlayerApi: () => this.playerApi,
          getSettings: () => {
            const config = this.config;
            if (!config) return DEFAULT_ENGINE_SETTINGS;
            return {
              ...DEFAULT_ENGINE_SETTINGS,
              style: config.style,
              maxTempoChange: config.maxTempoChange,
              blendBeats: config.blendBeats,
              bassSwap: config.bassSwap,
              harmonicMixing: config.harmonicMixing,
              skipIntros: config.skipIntros,
              phraseMixing: config.phraseMixing,
              fadeSeconds: config.fadeDuration,
              skipSameAlbum: config.skipSameAlbum,
            };
          },
          getIncomingAudio: (videoId) =>
            this.ipc?.invoke('smooth-crossfade:audio-head', videoId) as Promise<
              IncomingAudio | undefined
            >,
          isDebug: () => this.config?.debug ?? false,
        });
        this.updateOverlay?.();
        this.updateDebugHandle?.();
      };
      document.addEventListener('peard:audio-can-play', this.audioCanPlay, {
        capture: true,
        passive: true,
      });
    },

    stop() {
      if (this.audioCanPlay) {
        document.removeEventListener(
          'peard:audio-can-play',
          this.audioCanPlay,
          {
            capture: true,
          },
        );
      }
      this.overlay?.stop();
      this.overlay = undefined;
      this.engine?.destroy();
      this.engine = undefined;
      delete (window as { smoothCrossfade?: CrossfadeEngine }).smoothCrossfade;
    },

    onPlayerApiReady(playerApi) {
      this.playerApi = playerApi;
    },

    onConfigChange(newConfig) {
      this.config = newConfig;
      this.updateOverlay?.();
      this.updateDebugHandle?.();
    },
  },
});
