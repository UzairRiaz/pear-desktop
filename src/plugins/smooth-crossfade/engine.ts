import { analyzeBuffer, type BufferAnalysis } from './analysis/incoming';
import { LiveAnalyzer, type LoudnessProfile } from './analysis/live-tap';
import { AudioGraph } from './audio-graph';
import { effectiveFadeSeconds } from './curves';
import {
  DEFAULT_PLANNER_SETTINGS,
  planTransition,
  type PlannerSettings,
  type TransitionPlan,
} from './planner';
import {
  applyKeyframes,
  beatmatchSchedule,
  crossfadeSchedule,
  echoSchedule,
  valueAt,
  type Schedule,
} from './schedule';
import { atAudioTime, audioDelay } from './timers';
import {
  createPlayerAdapter,
  getQueueContext,
  type PlayerAdapter,
} from './ytm-adapter';

import type { TrackAnalysis } from './analysis/analyze';
import type { MusicPlayer } from '@/types/music-player';

/**
 * idle        normal playback; preloads and plans the next transition
 * preparing   beat-match only: ramping the outgoing tempo and re-locking
 *             onto its beat, both songs still sound as normal
 * transition  the schedule is running; both songs audible
 * handoff     switching YT Music's player over to the incoming song
 */
type State = 'idle' | 'preparing' | 'transition' | 'handoff';

export type IncomingAudio = {
  data: Uint8Array;
  mime: string;
  /** Seconds of audio the data covers (estimated from the bitrate). */
  seconds: number;
};

export type EngineSettings = PlannerSettings & {
  /** 'auto' picks beat-match / echo / crossfade per pair. */
  style: 'auto' | 'crossfade';
  /** Crossfade length (s) when not beat-matching. */
  fadeSeconds: number;
  /** Keep gapless albums gapless: no transition between tracks of one album. */
  skipSameAlbum: boolean;
  bassSwap: boolean;
  /**
   * Start beat-matched blends and echo-outs on the incoming song's first
   * steady downbeat, skipping an intro without a beat. Off: the intro is
   * heard (long beatless intros get a crossfade instead).
   */
  skipIntros: boolean;
  /** Start beat-matched blends and echo-outs on an outgoing phrase boundary. */
  phraseMixing: boolean;
};

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  ...DEFAULT_PLANNER_SETTINGS,
  style: 'auto',
  fadeSeconds: 6,
  skipSameAlbum: true,
  bassSwap: true,
  skipIntros: true,
  phraseMixing: true,
};

export type EngineOptions = {
  audioContext: AudioContext;
  mainSource: MediaElementAudioSourceNode;
  video: HTMLVideoElement;
  getPlayerApi: () => MusicPlayer | undefined;
  getSettings: () => EngineSettings;
  /** The first ~1 MiB of the incoming song's audio stream. */
  getIncomingAudio: (videoId: string) => Promise<IncomingAudio | undefined>;
  /** Detailed logs (status, beat sync, handoff steps) are on. */
  isDebug: () => boolean;
};

/** Everything the seekbar overlay draws. Times are song positions (s). */
export type OverlaySnapshot = {
  status: string;
  state: State;
  position: number;
  duration: number | null;
  /** The transition's span in song time, if one is planned or running. */
  window: { start: number; end: number } | null;
  profile: LoudnessProfile | undefined;
  outgoing: {
    analysis: TrackAnalysis;
    /** Detected beats (song time). */
    beats: number[];
    /** Beats extrapolated from the grid through the transition. */
    predicted: number[];
    /** Phrase starts (song time), when the phrase grid is trusted. */
    phrases: number[];
  } | null;
  /** The outgoing phrase boundary the transition aims for (song time). */
  phraseTarget: number | null;
  incoming:
    | (BufferAnalysis & {
        /** Incoming buffer time playing at song time `s` (NaN before it starts). */
        timeAt: (s: number) => number;
        /** Song time at which the incoming buffer reaches time `t`. */
        songAt: (t: number) => number;
      })
    | null;
  /** Gains and bass shelves (dB) at song time `s`. */
  levelsAt: (s: number) => {
    out: number;
    in: number;
    outBass: number;
    inBass: number;
  };
  plan: TransitionPlan | null;
};

type Prepared = {
  id: string;
  buffer: AudioBuffer;
  analysis: BufferAnalysis;
};

type Running = {
  schedule: Schedule;
  source: AudioBufferSourceNode;
  /** Audio-clock time the source started and the buffer time it started at. */
  startedAt: number;
  startOffset: number;
};

/** Start loading the next song this long before the current one ends. */
const PRELOAD_AT_REMAINING = 60;
/** Decide the transition this long before the end (after preloading). */
const PLAN_AT_REMAINING = 48;
/**
 * The transition must be over this long before the song ends. Switching
 * tracks while YT Music is about to auto-advance made it advance twice.
 */
const END_MARGIN_SECONDS = 4;
/** Beat-match: tempo ramp length, then how long to listen before locking on. */
const RAMP_SECONDS = 4;
const RAMP_STEPS = 16;
/** Listen at least this long, and to at least this many beats. */
const MEASURE_SECONDS = 4;
const MEASURE_BEATS = 12;
const MIN_LOCK_BEATS = 6;
/**
 * The long pre-ramp grid counts as this many beats of evidence when combined
 * with the short post-ramp measurement.
 */
const PRIOR_LOCK_BEATS = 12;
/**
 * Phase-locked loop during a blend: how often to check the beat offset, the
 * offset worth correcting, how long each correction lasts, and the largest
 * tempo nudge (pitch is preserved, like a DJ touching the jog wheel).
 */
const SYNC_INTERVAL_SECONDS = 1.5;
const SYNC_TOLERANCE_SECONDS = 0.008;
const SYNC_CORRECTION_SECONDS = 1.5;
const SYNC_MAX_NUDGE = 0.02;
/** Beats judged per check, the share of the offset corrected, and the
 * disagreement between beats above which the music is too irregular to judge. */
const SYNC_BEATS = 8;
const SYNC_DAMPING = 0.6;
const SYNC_MAX_SPREAD_SECONDS = 0.025;
/** Earliest an entry can be scheduled after the phase is measured. */
const ENTRY_LEAD_SECONDS = 0.5;
const HANDOFF_FADE_SECONDS = 0.15;
/** Rough time the main player needs to seek and start producing audio. */
const SEEK_LATENCY_SECONDS = 0.03;
/** Re-seek the main player if it lands further than this from the buffer. */
const MAX_HANDOFF_DRIFT_SECONDS = 0.02;
const MAX_HANDOFF_SEEKS = 3;
const HANDOFF_TIMEOUT_MS = 8000;
const POLL_SECONDS = 0.05;
/** How much of the outgoing song's recent playback is analysed. */
const OUTGOING_ANALYSIS_SECONDS = 120;
/** Phrase grids are only trusted above this confidence. */
const MIN_PHRASE_CONFIDENCE = 0.3;
/** Listen to the outgoing song this long before judging its beat. */
const MIN_LISTEN_SECONDS = 20;
/** Downbeats are only trusted above this confidence. */
const MIN_DOWNBEAT_CONFIDENCE = 0.3;
/** With intros kept, a beatless intro longer than this means a crossfade. */
const MAX_KEPT_INTRO_SECONDS = 4;
/** Leading silence in the incoming song is skipped up to this long. */
const MAX_INTRO_SKIP_SECONDS = 5;

const log = (...args: unknown[]) => console.log('[smooth-crossfade]', ...args);

const describe = (a: TrackAnalysis) => {
  const bpm = a.grid ? (60 / a.grid.period).toFixed(2) : '?';
  const parts = Object.entries(a.confidenceParts)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(' ');
  const key = a.key
    ? `${a.key.name} (${a.key.camelot}, ${a.key.confidence.toFixed(2)})`
    : '?';
  return `${bpm} BPM, beat confidence ${a.beatConfidence.toFixed(2)} [${parts}], ${a.downbeats?.meter ?? '?'}/4 downbeat confidence ${a.downbeats?.confidence.toFixed(2) ?? '?'}, key ${key}`;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Time of the song's first downbeat (or beat) once it has started. */
const firstEntryBeat = (analysis: TrackAnalysis) => {
  const { beats, downbeats, loudness } = analysis;
  const useDownbeats =
    downbeats && downbeats.confidence >= MIN_DOWNBEAT_CONFIDENCE;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] < loudness.firstSound - 0.05) continue;
    if (!useDownbeats || (i - downbeats.first) % downbeats.meter === 0) {
      return beats[i];
    }
  }
  return null;
};

export class CrossfadeEngine {
  readonly ctx: AudioContext;
  readonly live: LiveAnalyzer;
  private readonly video: HTMLVideoElement;
  private readonly player: PlayerAdapter;
  private readonly graph: AudioGraph;
  private readonly cleanups: (() => void)[] = [];

  private state: State = 'idle';
  /** Bumped whenever a transition starts or is cancelled. */
  private run = 0;
  private status = 'starting';
  private lastVideoId: string | null = null;
  private lastStatusLog = 0;
  private sameAlbumLoggedFor: string | null = null;

  private loadingId: string | null = null;
  private failedId: string | null = null;
  private prepared: Prepared | null = null;
  private plan: TransitionPlan | null = null;
  /** Song time at which the planned transition starts. */
  private planStart: number | null = null;
  /** Song time of the outgoing phrase boundary the transition aims for. */
  private phraseTarget: number | null = null;
  private running: Running | null = null;
  private ownSeek = false;
  private ownRateChange = false;
  /** Set while we have changed the playback rate. */
  private changedRate = false;
  private overlayCache: {
    at: number;
    outgoing: OverlaySnapshot['outgoing'];
  } | null = null;

  constructor(private readonly options: EngineOptions) {
    this.ctx = options.audioContext;
    this.video = options.video;
    this.player = createPlayerAdapter(options.getPlayerApi, this.video);
    this.lastVideoId = this.player.videoId();
    this.graph = new AudioGraph(this.ctx, options.mainSource);

    this.live = new LiveAnalyzer(this.ctx, this.graph.mainInput, {
      video: this.video,
      getTrackId: this.player.videoId,
      getPosition: this.player.position,
      getDuration: this.player.duration,
    });
    this.live.start().catch((error) => log('live analysis unavailable', error));

    this.listen(this.video, 'timeupdate', () => {
      this.checkTrackChange();
      this.tick();
    });
    for (const type of ['loadstart', 'playing']) {
      this.listen(this.video, type, () => this.checkTrackChange());
    }
    this.listen(this.video, 'seeking', () => this.onSeeking());
    this.listen(this.video, 'pause', () => this.onPause());
    this.listen(this.video, 'play', () => this.onPlay());
    this.listen(this.video, 'volumechange', () => this.syncVolume());
    // The beat grid doesn't survive a jump in playback; measure afresh.
    for (const type of ['seeked', 'play']) {
      this.listen(this.video, type, () => this.live.restart());
    }
    this.listen(this.video, 'ratechange', () => {
      if (!this.ownRateChange) this.live.restart();
    });
    this.syncVolume();
    this.debug('engine ready');
  }

  destroy() {
    this.cancel('plugin stopped');
    this.live.destroy();
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.graph.destroy();
  }

  private debug(...args: unknown[]) {
    if (this.options.isDebug()) log(...args);
  }

  private listen(target: EventTarget, type: string, handler: EventListener) {
    target.addEventListener(type, handler, { passive: true });
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  /** The player's volume is applied before the graph; mirror it for ours. */
  private syncVolume() {
    const volume = this.video.muted ? 0 : this.video.volume;
    this.graph.incomingVolume.gain.setTargetAtTime(
      volume,
      this.ctx.currentTime,
      0.02,
    );
  }

  private get settings() {
    return this.options.getSettings();
  }

  // --- idle: preload, plan, trigger -----------------------------------------

  private tick() {
    if (this.state !== 'idle' || this.video.paused) return;

    const currentId = this.player.videoId();
    const queue = getQueueContext(currentId);
    const duration = this.player.duration();
    if (!currentId || !duration) {
      this.status = 'waiting for track info';
      return;
    }
    const { nextId } = queue;
    if (!nextId) {
      this.status = 'no next track';
      return;
    }
    if (nextId === this.failedId) {
      this.status = 'next track unavailable, plain switch';
      return;
    }
    if (
      this.settings.skipSameAlbum &&
      queue.currentAlbumId &&
      queue.currentAlbumId === queue.nextAlbumId
    ) {
      this.status = 'same album, gapless switch';
      if (this.sameAlbumLoggedFor !== currentId) {
        this.sameAlbumLoggedFor = currentId;
        this.debug(
          `same album (${queue.currentAlbumId}), no transition to ${nextId}`,
        );
      }
      return;
    }

    const position = this.player.position();
    const remaining = duration - position;

    // The queue can change under us; drop whatever was prepared for another song.
    if (this.prepared && this.prepared.id !== nextId) this.resetPrepared();

    if (Date.now() - this.lastStatusLog > 5000) {
      this.lastStatusLog = Date.now();
      this.debug(
        `cur=${currentId} next=${nextId} pos=${position.toFixed(1)}/${duration.toFixed(1)} prepared=${this.prepared?.id ?? null} plan=${this.plan?.style ?? null} start=${this.planStart?.toFixed(1) ?? null}`,
      );
    }

    if (
      remaining <= PRELOAD_AT_REMAINING &&
      !this.prepared &&
      this.loadingId !== nextId
    ) {
      this.prepare(nextId);
    }
    if (!this.prepared) {
      this.status =
        this.loadingId === nextId
          ? 'loading next track'
          : `preloading in ${Math.max(0, remaining - PRELOAD_AT_REMAINING).toFixed(0)}s`;
      return;
    }

    // Plan once enough of the outgoing song has been heard (e.g. after a
    // seek), or when a crossfade would have to start now anyway.
    const fade = effectiveFadeSeconds(this.settings.fadeSeconds, duration);
    const lastChance = remaining <= fade + END_MARGIN_SECONDS + 1;
    if (
      !this.plan &&
      remaining <= PLAN_AT_REMAINING &&
      (this.live.seconds >= MIN_LISTEN_SECONDS || lastChance)
    ) {
      this.makePlan(duration, position);
    }
    if (!this.plan || this.planStart === null) {
      this.status = 'next track ready';
      return;
    }

    this.status = `${this.plan.style} in ${Math.max(0, this.planStart - position).toFixed(0)}s: ${this.plan.reason}`;
    if (position >= this.planStart) this.start();
  }

  private prepare(nextId: string) {
    this.loadingId = nextId;
    const stale = () => this.loadingId !== nextId;
    (async () => {
      const audio = await this.options.getIncomingAudio(nextId);
      if (stale()) return;
      if (!audio) throw new Error('no audio data');

      const buffer = await this.ctx.decodeAudioData(audio.data.slice().buffer);
      if (stale()) return;
      const started = performance.now();
      const analysis = await analyzeBuffer(buffer, stale);
      if (!analysis || stale()) return;

      this.prepared = { id: nextId, buffer, analysis };
      this.loadingId = null;
      this.debug(
        `prepared ${nextId}: ${buffer.duration.toFixed(1)}s decoded, analysed in ${Math.round(performance.now() - started)}ms: ${describe(analysis.analysis)}`,
      );
    })().catch((error) => {
      if (stale()) return;
      log('preload failed, plain switch for', nextId, error);
      this.failedId = nextId;
      this.loadingId = null;
    });
  }

  private makePlan(duration: number, position: number) {
    const prepared = this.prepared!;
    const settings = this.settings;
    const outgoing = this.live.analyzeRecent(OUTGOING_ANALYSIS_SECONDS);
    this.debug(
      `outgoing (last ${this.live.seconds.toFixed(0)}s): ${outgoing ? describe(outgoing) : 'not measured'}`,
    );

    let plan =
      settings.style === 'crossfade'
        ? null
        : planTransition(outgoing, prepared.analysis.analysis, settings);
    // Keeping intros: a long stretch before the incoming song's first steady
    // downbeat can't be beat-matched without skipping it, so crossfade.
    if (!settings.skipIntros && plan && plan.style !== 'crossfade') {
      const incoming = prepared.analysis.analysis;
      const entryBeat = firstEntryBeat(incoming);
      const intro =
        entryBeat === null ? Infinity : entryBeat - incoming.loudness.firstSound;
      if (intro > MAX_KEPT_INTRO_SECONDS) {
        plan = {
          ...plan,
          style: 'crossfade',
          reason:
            entryBeat === null
              ? 'keeping the intro (no steady downbeat found)'
              : `keeping the ${intro.toFixed(0)}s intro`,
        };
      }
    }

    const fade = effectiveFadeSeconds(settings.fadeSeconds, duration);
    const end = duration - END_MARGIN_SECONDS;

    let start: number | null = null;
    if (plan?.style === 'beatmatch' && prepared.analysis.analysis.grid) {
      const inBeat = prepared.analysis.analysis.grid.period;
      const bar = inBeat * 4;
      const needed =
        RAMP_SECONDS +
        Math.max(MEASURE_SECONDS, MEASURE_BEATS * inBeat) +
        bar +
        (plan.beats * inBeat) +
        1;
      start = end - needed;
      if (start < position + 1 || this.video.playbackRate !== 1) {
        plan = {
          ...plan,
          style: 'crossfade',
          reason:
            this.video.playbackRate !== 1
              ? 'playback speed is changed'
              : 'not enough time left to beat-match',
        };
      }
    } else if (plan?.style === 'echo' && outgoing?.grid) {
      start = end - (outgoing.grid.period * 8);
    }

    // Phrase mixing: move the start so the blend (or echo cut) begins on an
    // outgoing phrase boundary, the latest one that still fits.
    this.phraseTarget = null;
    const phraseGrid = outgoing ? this.outgoingPhraseGrid(outgoing) : null;
    if (
      settings.phraseMixing &&
      phraseGrid &&
      start !== null &&
      (plan?.style === 'beatmatch' || plan?.style === 'echo')
    ) {
      const inBeat = prepared.analysis.analysis.grid?.period ?? 0.5;
      // Time needed before the boundary, and song needed after it.
      const before =
        plan.style === 'beatmatch'
          ? RAMP_SECONDS +
            Math.max(MEASURE_SECONDS, MEASURE_BEATS * inBeat) +
            ENTRY_LEAD_SECONDS +
            1
          : ENTRY_LEAD_SECONDS + 1.5;
      const after =
        plan.style === 'beatmatch'
          ? plan.beats * inBeat * plan.outgoingRate
          : (outgoing?.downbeats?.meter ?? 4) * (outgoing?.grid?.period ?? 0.5);
      const { anchor, length } = phraseGrid;
      for (let k = Math.floor((end - anchor) / length); k > -64; k--) {
        const boundary = anchor + (k * length);
        if (boundary + after > end) continue;
        if (boundary - before < position + 1) break;
        this.phraseTarget = boundary;
        start = boundary - before;
        plan = { ...plan, reason: `${plan.reason}, on a phrase` };
        break;
      }
      this.debug(
        this.phraseTarget === null
          ? 'phrase: no boundary fits, entering on the next downbeat'
          : `phrase: ${phraseGrid.beatsPerPhrase}-beat phrases (confidence ${phraseGrid.confidence.toFixed(2)}), entering at song ${this.phraseTarget.toFixed(2)}s`,
      );
    }

    if (!plan || plan.style === 'crossfade') {
      plan ??= {
        style: 'crossfade',
        reason: 'crossfade only',
        outBpm: null,
        inBpm: null,
        keysCompatible: null,
      };
      start = end - fade;
    }

    this.plan = plan;
    this.planStart = Math.max(position, start ?? end - fade);
    log(
      `plan: ${plan.style} at ${this.planStart.toFixed(1)}s (${plan.reason}); keys compatible: ${plan.keysCompatible ?? 'unknown'}`,
    );
  }

  // --- running a transition ---------------------------------------------------

  private start() {
    const plan = this.plan!;
    const run = ++this.run;
    const task =
      plan.style === 'beatmatch'
        ? this.runBeatmatch(run, plan)
        : plan.style === 'echo'
          ? this.runEcho(run)
          : this.runCrossfade(run);
    task.catch((error) => {
      log('transition failed', error);
      if (run === this.run) this.cancel('transition failed');
    });
  }

  private runCrossfade(run: number) {
    const prepared = this.prepared!;
    const duration = this.player.duration() ?? 0;
    const fade = effectiveFadeSeconds(this.settings.fadeSeconds, duration);
    const { firstSound } = prepared.analysis.analysis.loudness;
    const schedule = crossfadeSchedule({
      start: this.ctx.currentTime + 0.05,
      fade,
      // Skip leading silence so the incoming song is heard right away.
      incomingOffset:
        firstSound <= MAX_INTRO_SKIP_SECONDS
          ? Math.max(0, firstSound - 0.05)
          : 0,
    });
    return this.perform(run, schedule);
  }

  private async runEcho(run: number) {
    const incoming = this.prepared!.analysis.analysis;
    const outgoing = this.live.analyzeRecent(30);
    const entryBeat = firstEntryBeat(incoming);
    if (!outgoing?.grid || entryBeat === null) return this.runCrossfade(run);

    const period = outgoing.grid.period;
    let cut = this.nextOutgoingBeat(
      outgoing,
      this.ctx.currentTime + ENTRY_LEAD_SECONDS,
      true,
    );
    // Aiming for a phrase boundary: cut on the grid beat nearest to it.
    if (this.phraseTarget !== null) {
      const target = this.live.fromMediaTime(this.phraseTarget);
      const onGrid =
        outgoing.grid.origin +
        (Math.round((target - outgoing.grid.origin) / period) * period);
      if (onGrid >= this.ctx.currentTime + ENTRY_LEAD_SECONDS) cut = onGrid;
    }
    const schedule = echoSchedule({
      cut,
      beatSeconds: period,
      barBeats: outgoing.downbeats?.meter ?? 4,
      incomingDownbeat: entryBeat,
      keepIntro: !this.settings.skipIntros,
    });
    return this.perform(run, schedule);
  }

  private async runBeatmatch(
    run: number,
    plan: Extract<TransitionPlan, { style: 'beatmatch' }>,
  ) {
    const incoming = this.prepared!.analysis.analysis;
    const preAnalysis = this.live.analyzeRecent(OUTGOING_ANALYSIS_SECONDS);
    const entryBeat = firstEntryBeat(incoming);
    if (!preAnalysis?.grid || !incoming.grid || entryBeat === null) {
      log('beat-match: analysis missing, crossfading instead');
      return this.runCrossfade(run);
    }
    this.state = 'preparing';

    // 1. Ramp the outgoing tempo to the incoming one while it plays alone.
    // Even 0.1% adds up to ~15 ms over a long blend, so only skip the ramp
    // when the tempos are practically identical.
    const rate = plan.outgoingRate;
    if (Math.abs(rate - 1) > 0.0002) {
      for (let step = 1; step <= RAMP_STEPS; step++) {
        this.setRate(1 + ((rate - 1) * (step / RAMP_STEPS)));
        await audioDelay(this.ctx, RAMP_SECONDS / RAMP_STEPS);
        if (run !== this.run) return;
      }
    }
    const rampEnd = this.ctx.currentTime;

    // 2. Listen at the new tempo and lock onto the outgoing beat.
    const outBeat = preAnalysis.grid.period / rate;
    await audioDelay(
      this.ctx,
      Math.max(MEASURE_SECONDS, MEASURE_BEATS * outBeat),
    );
    if (run !== this.run) return;
    const beats = this.live.beatsSince(rampEnd + 0.2, 60 / outBeat);
    if (beats.length < MIN_LOCK_BEATS) {
      log(
        `beat-match: only ${beats.length} beats after the ramp, crossfading instead`,
      );
      return this.runCrossfade(run);
    }
    // Prediction: beats sit at fixed song positions, so carry the long
    // pre-ramp grid through the tempo change via the song-time mapping.
    const pre = preAnalysis.grid;
    const anchorSong = this.live.toMediaTime(pre.origin);
    const now = this.ctx.currentTime;
    const beatsToNow = Math.round(
      (this.live.toMediaTime(now) - anchorSong) / pre.period,
    );
    const predicted = this.live.fromMediaTime(
      anchorSong + (beatsToNow * pre.period),
    );
    // Measurement: how far the beats actually heard sit from the prediction.
    const offsets = beats.map((b) => {
      const d = b - predicted;
      return d - (Math.round(d / outBeat) * outBeat);
    });
    const measured = median(offsets);
    // Combine, trusting the measurement more the more beats it heard.
    const weight = beats.length / (beats.length + PRIOR_LOCK_BEATS);
    const origin = predicted + (measured * weight);
    this.debug(
      `beat-match: predicted grid vs heard beats ${(measured * 1000).toFixed(0)}ms (${beats.length} beats), using ${(measured * weight * 1000).toFixed(0)}ms`,
    );

    // 3. Enter on an outgoing downbeat with the incoming song's first downbeat.
    const entry = this.nextDownbeat(preAnalysis, origin, outBeat);
    const inBeat = incoming.grid.period;
    let blendBeats = plan.beats;
    const buffer = this.prepared!.buffer;
    // Both songs must still have audio when the blend ends.
    const fits = (n: number) => {
      const end = entry + (n * inBeat);
      const outgoingEnd = this.live.toMediaTime(end);
      const songEnd = (this.player.duration() ?? Infinity) - 1.5;
      return (
        outgoingEnd <= songEnd && entryBeat + (n * inBeat) + 3 <= buffer.duration
      );
    };
    while (blendBeats > 8 && !fits(blendBeats)) blendBeats /= 2;
    if (!fits(blendBeats)) {
      log('beat-match: blend does not fit, crossfading instead');
      return this.runCrossfade(run);
    }

    this.debug(
      `beat-match: entry in ${(entry - this.ctx.currentTime).toFixed(2)}s, ${blendBeats} beats`,
    );

    const schedule = beatmatchSchedule({
      entry,
      incomingDownbeat: entryBeat,
      beatSeconds: inBeat,
      beats: blendBeats,
      keepIntro: !this.settings.skipIntros,
    });
    const performing = this.perform(run, schedule);
    this.holdSync(run, schedule, rate, outBeat).catch((error) =>
      log('beat sync stopped', error),
    );
    return performing;
  }

  /**
   * Keeps the outgoing beat on the incoming one during the blend. The
   * incoming buffer's beats are known exactly; the live tap hears where the
   * outgoing beats land. Any offset is closed by briefly nudging the outgoing
   * tempo.
   */
  private async holdSync(
    run: number,
    schedule: Schedule,
    baseRate: number,
    outBeat: number,
  ) {
    const incoming = this.prepared?.analysis.analysis;
    if (!incoming?.grid) return;
    const entry = schedule.automation.incomingGain[0].time;
    // Stop once the outgoing song is mostly faded out.
    const until = entry + (0.75 * (schedule.end - entry));
    let listenFrom = entry;

    while (run === this.run && this.state === 'transition') {
      await audioDelay(this.ctx, SYNC_INTERVAL_SECONDS);
      if (run !== this.run || this.ctx.currentTime >= until) return;
      const running = this.running;
      if (!running) return;

      const heard = this.live
        .beatsSince(listenFrom, 60 / outBeat)
        .slice(-SYNC_BEATS);
      if (heard.length < 4) continue;
      const playing = incoming.beats.map(
        (b) => running.startedAt + (b - running.startOffset),
      );
      const offsets = heard.map((t) => {
        let best = Infinity;
        for (const u of playing)
          if (Math.abs(t - u) < Math.abs(best)) best = t - u;
        return best;
      });
      const offset = median(offsets);
      const spread = median(offsets.map((o) => Math.abs(o - offset)));
      if (spread > SYNC_MAX_SPREAD_SECONDS) {
        this.debug(
          `beat sync: beats too irregular to judge (spread ${(spread * 1000).toFixed(0)}ms), holding`,
        );
        continue;
      }
      if (Math.abs(offset) < SYNC_TOLERANCE_SECONDS) continue;

      // Outgoing late (offset > 0) → speed it up until it has caught up.
      // Only part of the offset is corrected, so noise can't make it swing.
      const correction = offset * SYNC_DAMPING;
      const nudge = Math.max(
        -SYNC_MAX_NUDGE,
        Math.min(SYNC_MAX_NUDGE, correction / SYNC_CORRECTION_SECONDS),
      );
      const seconds = Math.abs(correction / nudge);
      this.debug(
        `beat sync: outgoing ${offset >= 0 ? '+' : ''}${(offset * 1000).toFixed(0)}ms off, nudging ${nudge >= 0 ? '+' : ''}${(nudge * 100).toFixed(2)}% for ${seconds.toFixed(2)}s`,
      );
      this.setRate(baseRate * (1 + nudge));
      await audioDelay(this.ctx, seconds);
      if (run !== this.run) return;
      this.setRate(baseRate);
      // Judge the next correction only on beats heard after this one.
      listenFrom = this.ctx.currentTime + 0.1;
    }
  }

  /**
   * The outgoing song's phrase grid in song time: phrase starts sit at
   * `anchor + k * length`. Extends past the analysed audio, since the
   * boundary we want is usually still ahead.
   */
  private outgoingPhraseGrid(analysis: TrackAnalysis) {
    const { phrases, grid } = analysis;
    if (!phrases || !grid || phrases.confidence < MIN_PHRASE_CONFIDENCE) {
      return null;
    }
    const last = phrases.starts.at(-1);
    if (last === undefined || analysis.beats[last] === undefined) return null;
    return {
      anchor: this.live.toMediaTime(analysis.beats[last]),
      // Analysed at playback rate 1, so its beat period is in song time.
      length: phrases.beatsPerPhrase * grid.period,
      beatsPerPhrase: phrases.beatsPerPhrase,
      confidence: phrases.confidence,
    };
  }

  /** First outgoing beat after `after` from a live analysis (optionally a downbeat). */
  private nextOutgoingBeat(
    analysis: TrackAnalysis,
    after: number,
    downbeat: boolean,
  ) {
    const { grid, downbeats } = analysis;
    const period = grid!.period;
    let k = Math.ceil((after - grid!.origin) / period);
    const useDown =
      downbeat && downbeats && downbeats.confidence >= MIN_DOWNBEAT_CONFIDENCE;
    if (useDown) {
      // Grid index of the first detected downbeat (the grid is re-indexed).
      const firstDown = analysis.beats[downbeats.first];
      const downIndex = Math.round((firstDown - grid!.origin) / period);
      while (
        (((k - downIndex) % downbeats.meter) + downbeats.meter) %
          downbeats.meter !==
        0
      )
        k++;
    }
    return grid!.origin + (k * period);
  }

  /**
   * The first beat of the re-locked grid (`origin`, `beat`) after the entry
   * lead that is a downbeat of the song, judged in song time against the
   * downbeats found before the tempo ramp.
   */
  private nextDownbeat(pre: TrackAnalysis, origin: number, beat: number) {
    const earliest = this.ctx.currentTime + ENTRY_LEAD_SECONDS;
    let k = Math.ceil((earliest - origin) / beat);
    const { downbeats, grid } = pre;

    // Aiming for a phrase boundary: the beat that lands on it in song time.
    if (this.phraseTarget !== null && grid) {
      for (let i = k; i < k + 64; i++) {
        const t = origin + (i * beat);
        const s = this.live.toMediaTime(t);
        if (Math.abs(s - this.phraseTarget) < grid.period / 2) return t;
        if (s > this.phraseTarget) break;
      }
      log('beat-match: phrase boundary missed, entering on the next downbeat');
    }

    if (!downbeats || downbeats.confidence < MIN_DOWNBEAT_CONFIDENCE || !grid) {
      return origin + (k * beat);
    }
    // Bars are fixed in song time, so a tempo change doesn't move them: map
    // each candidate beat to song time and compare with the song's bar grid.
    // (The pre-ramp analysis ran at rate 1, so its period is in song time.)
    const firstDown = this.live.toMediaTime(pre.beats[downbeats.first]);
    const songBar = downbeats.meter * grid.period;
    for (let tries = 0; tries < 16; tries++, k++) {
      const t = origin + (k * beat);
      const bars = (this.live.toMediaTime(t) - firstDown) / songBar;
      const beatsOff = Math.abs(bars - Math.round(bars)) * downbeats.meter;
      if (beatsOff < 0.5) return t;
    }
    log('beat-match: no downbeat found, entering on a beat');
    return origin + (Math.ceil((earliest - origin) / beat) * beat);
  }

  private setRate(rate: number) {
    this.ownRateChange = true;
    this.changedRate = rate !== 1;
    this.video.preservesPitch = true;
    this.video.playbackRate = rate;
    this.live.noteRateChange(rate);
    // `ratechange` fires asynchronously; clear the flag after it has.
    setTimeout(() => {
      this.ownRateChange = false;
    }, 0);
  }

  /** Starts the incoming buffer, applies the schedule, then hands off. */
  private async perform(run: number, schedule: Schedule) {
    if (run !== this.run) return;
    const prepared = this.prepared!;
    const now = this.ctx.currentTime;

    const source = this.ctx.createBufferSource();
    source.buffer = prepared.buffer;
    source.connect(this.graph.incomingVolume);
    let when = schedule.incomingStart;
    let offset = schedule.incomingOffset;
    if (when < now + 0.01) {
      offset += now + 0.01 - when;
      when = now + 0.01;
    }
    source.start(when, offset);
    this.running = { schedule, source, startedAt: when, startOffset: offset };

    const { automation } = schedule;
    const bass = this.settings.bassSwap;
    applyKeyframes(this.graph.mainGain.gain, automation.mainGain, now);
    applyKeyframes(this.graph.incomingGain.gain, automation.incomingGain, now);
    applyKeyframes(
      this.graph.mainBass.gain,
      bass ? automation.mainBass : [{ time: now, value: 0 }],
      now,
    );
    applyKeyframes(
      this.graph.incomingBass.gain,
      bass ? automation.incomingBass : [{ time: now, value: 0 }],
      now,
    );
    applyKeyframes(this.graph.echoSend.gain, automation.echoSend, now);
    if (schedule.echoDelay)
      this.graph.echo.delayTime.value = schedule.echoDelay;

    this.state = 'transition';
    this.status = `${schedule.style}: ${this.plan?.reason ?? ''}`;
    this.debug(
      `${schedule.style}: incoming starts in ${(when - now).toFixed(2)}s at ${offset.toFixed(2)}s, outgoing silent in ${(schedule.end - now).toFixed(2)}s (song ${this.player.position().toFixed(2)}s)`,
    );

    // On the audio clock: a pause (suspended context) pauses this too.
    await atAudioTime(this.ctx, schedule.end);
    if (run !== this.run) return;
    if (schedule.style === 'beatmatch') this.logAlignment(schedule);
    await this.handoff(run);
  }

  /**
   * How well the beats lined up during the blend: outgoing beats as the live
   * tap heard them vs. where the incoming buffer's beats were playing.
   */
  private logAlignment(schedule: Schedule) {
    const running = this.running;
    const incoming = this.prepared?.analysis.analysis;
    const grid = incoming?.grid;
    if (!running || !incoming || !grid) return;
    const entry = schedule.automation.incomingGain[0].time;
    const heard = this.live.beatsSince(
      entry,
      60 / (grid.period * (this.video.playbackRate || 1)),
    );
    const playing = incoming.beats.map(
      (b) => running.startedAt + (b - running.startOffset),
    );
    const errors = heard
      .map((t) => {
        let best = Infinity;
        for (const u of playing)
          if (Math.abs(t - u) < Math.abs(best)) best = t - u;
        return best * 1000;
      })
      .filter((ms) => Math.abs(ms) < grid.period * 500);
    if (errors.length === 0) return;
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const sd = Math.sqrt(
      errors.reduce((a, b) => a + ((b - mean) ** 2), 0) / errors.length,
    );
    log(
      `blend alignment over ${errors.length} beats: outgoing ${mean >= 0 ? '+' : ''}${mean.toFixed(1)}ms vs incoming (sd ${sd.toFixed(1)}ms, worst ${Math.max(...errors.map(Math.abs)).toFixed(0)}ms); per beat: ${errors.map((ms) => ms.toFixed(0)).join(' ')}`,
    );
  }

  /** Buffer time the incoming song is at, at audio-clock time `t`. */
  private incomingTimeAt(t = this.ctx.currentTime) {
    const running = this.running;
    if (!running) return Number.NaN;
    return running.startOffset + (t - running.startedAt);
  }

  // --- handoff --------------------------------------------------------------

  private waitForVideo(type: string, timeoutMs: number) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.video.removeEventListener(type, onEvent);
        resolve(ok);
      };
      const onEvent = () => finish(true);
      this.video.addEventListener(type, onEvent);
    });
  }

  /** Polls `condition` on the audio clock until it holds or time runs out. */
  private async waitUntil(condition: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline) return false;
      await audioDelay(this.ctx, POLL_SECONDS);
    }
    return true;
  }

  private async handoff(run: number) {
    this.state = 'handoff';
    const target = this.prepared!.id;
    const outgoingId = this.player.videoId();
    this.debug(
      `handoff: song ${this.player.position().toFixed(2)}s, incoming at ${this.incomingTimeAt().toFixed(2)}s`,
    );
    const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
    const left = () => Math.max(0, deadline - Date.now());

    // The outgoing song is silent: undo its tempo change, then switch. A full
    // reload fires media events and a gapless switch doesn't, so wait for the
    // player to report the new song.
    if (this.changedRate) this.setRate(1);
    this.player.next();
    const switched =
      (await this.waitUntil(
        () => this.player.videoId() !== outgoingId,
        left(),
      )) &&
      (await this.waitUntil(
        () =>
          !this.video.paused &&
          this.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
        left(),
      ));
    if (run !== this.run) return;
    this.lastVideoId = this.player.videoId();
    this.live.restart();
    if (!switched || this.player.videoId() !== target) {
      log(
        `handoff landed on ${this.player.videoId()} (expected ${target}${switched ? '' : ', timed out'}), switching without alignment`,
      );
      this.finish(true);
      return;
    }

    // Line the main player up with the incoming buffer. How long a seek takes
    // to settle varies, so measure where it landed and correct if needed.
    this.ownSeek = true;
    let lead = SEEK_LATENCY_SECONDS;
    for (let attempt = 1; attempt <= MAX_HANDOFF_SEEKS; attempt++) {
      const seeked = this.waitForVideo('seeked', left());
      this.player.seekTo(this.incomingTimeAt() + lead);
      await seeked;
      if (this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        await this.waitForVideo('canplay', left());
      }
      if (run !== this.run) return;
      const drift = this.player.position() - this.incomingTimeAt();
      this.debug(
        `aligned (seek ${attempt}): main ${this.player.position().toFixed(3)}s vs buffer ${this.incomingTimeAt().toFixed(3)}s (${(drift * 1000).toFixed(0)}ms)`,
      );
      if (Math.abs(drift) <= MAX_HANDOFF_DRIFT_SECONDS || left() === 0) break;
      lead -= drift;
    }
    this.ownSeek = false;

    // Both play the same audio now, so a linear (not equal-power) blend. The
    // main path gets its bass back at the same time.
    const now = this.ctx.currentTime;
    const end = now + HANDOFF_FADE_SECONDS;
    applyKeyframes(this.graph.mainBass.gain, [{ time: now, value: 0 }], now);
    applyKeyframes(
      this.graph.mainGain.gain,
      [
        { time: now, value: 0 },
        { time: end, value: 1 },
      ],
      now,
    );
    applyKeyframes(
      this.graph.incomingGain.gain,
      [
        { time: now, value: this.graph.incomingGain.gain.value },
        { time: end, value: 0 },
      ],
      now,
    );
    await atAudioTime(this.ctx, end + 0.03);
    if (run !== this.run) return;
    this.finish(false);
  }

  private finish(smooth: boolean) {
    log(`handoff complete: now playing ${this.player.videoId()}`);
    this.stopTransition(smooth);
    this.resetPrepared();
    this.failedId = null;
    this.state = 'idle';
  }

  // --- user actions and cancelling ------------------------------------------

  private checkTrackChange() {
    const id = this.player.videoId();
    if (id === this.lastVideoId) return;
    this.lastVideoId = id;
    if (this.state === 'handoff') return; // our own switch
    this.live.restart();
    this.debug(`track changed to ${id} (state=${this.state})`);
    // Manual skip / previous / picked a song: no transition, plain switch.
    this.failedId = null;
    this.cancel('track changed outside a transition');
    this.resetPrepared();
  }

  private onSeeking() {
    if (this.ownSeek) return;
    if (this.state === 'preparing' || this.state === 'transition') {
      this.cancel('seek during transition');
    } else if (this.state === 'idle') {
      // A seek invalidates the plan's timing; plan again from the new spot.
      this.plan = null;
      this.planStart = null;
      this.phraseTarget = null;
    }
  }

  private onPause() {
    if (this.state === 'preparing' || this.state === 'transition') {
      this.ctx.suspend();
    }
  }

  private onPlay() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** Abort any transition and return to normal single-player playback. */
  private cancel(reason: string) {
    if (this.state !== 'idle' || this.running) {
      log(
        `cancel (${reason}) state=${this.state} song=${this.player.position().toFixed(2)}`,
      );
    }
    this.run++;
    if (this.ctx.state === 'suspended' && !this.video.paused) this.ctx.resume();
    if (this.changedRate) this.setRate(1);
    this.stopTransition(true);
    this.plan = null;
    this.planStart = null;
    this.phraseTarget = null;
    this.state = 'idle';
    this.ownSeek = false;
  }

  private stopTransition(smooth: boolean) {
    const now = this.ctx.currentTime;
    const settle = smooth ? 0.05 : 0;
    const to = (param: AudioParam, value: number) =>
      applyKeyframes(
        param,
        [
          { time: now, value: param.value },
          { time: now + settle, value },
        ],
        now,
      );
    to(this.graph.mainGain.gain, 1);
    to(this.graph.incomingGain.gain, 0);
    to(this.graph.mainBass.gain, 0);
    to(this.graph.incomingBass.gain, 0);
    to(this.graph.echoSend.gain, 0);
    const running = this.running;
    this.running = null;
    if (running) {
      try {
        running.source.stop(now + settle + 0.01);
      } catch {}
    }
  }

  private resetPrepared() {
    this.prepared = null;
    this.loadingId = null;
    this.plan = null;
    this.planStart = null;
    this.phraseTarget = null;
  }

  // --- overlay --------------------------------------------------------------

  /** Roughly what the planned transition will do, for the overlay. */
  private previewSchedule(
    duration: number,
    songToClock: (s: number) => number,
  ): Schedule {
    const fade = effectiveFadeSeconds(this.settings.fadeSeconds, duration);
    const start = songToClock(
      this.planStart ?? duration - END_MARGIN_SECONDS - fade,
    );
    const incoming = this.prepared!.analysis.analysis;
    const entryBeat = firstEntryBeat(incoming);
    const plan = this.plan;
    const outgoing = this.overlayCache?.outgoing?.analysis;

    if (plan?.style === 'beatmatch' && incoming.grid && entryBeat !== null) {
      const measure = Math.max(
        MEASURE_SECONDS,
        MEASURE_BEATS * incoming.grid.period,
      );
      return beatmatchSchedule({
        entry: start + RAMP_SECONDS + measure + ENTRY_LEAD_SECONDS,
        incomingDownbeat: entryBeat,
        keepIntro: !this.settings.skipIntros,
        beatSeconds: incoming.grid.period,
        beats: plan.beats,
      });
    }
    if (plan?.style === 'echo' && outgoing?.grid && entryBeat !== null) {
      return echoSchedule({
        cut: this.nextOutgoingBeat(outgoing, start + ENTRY_LEAD_SECONDS, true),
        beatSeconds: outgoing.grid.period,
        barBeats: outgoing.downbeats?.meter ?? 4,
        incomingDownbeat: entryBeat,
        keepIntro: !this.settings.skipIntros,
      });
    }
    const { firstSound } = incoming.loudness;
    return crossfadeSchedule({
      start,
      fade,
      incomingOffset:
        firstSound <= MAX_INTRO_SKIP_SECONDS
          ? Math.max(0, firstSound - 0.05)
          : 0,
    });
  }

  /** Snapshot for the seekbar overlay; cheap enough to call every frame. */
  getOverlaySnapshot(): OverlaySnapshot {
    const currentId = this.player.videoId();
    const duration = this.player.duration();
    const position = this.player.position();
    const now = this.ctx.currentTime;
    const rate = this.video.playbackRate || 1;
    // Song time ↔ audio clock, assuming the current rate holds.
    const songToClock = (s: number) => now + ((s - position) / rate);

    const running = this.running;
    let schedule: Schedule | null = running?.schedule ?? null;
    let preview: { start: number; offset: number } | null = null;
    if (!schedule && this.prepared && duration) {
      // Not running yet: preview the planned transition at its planned start.
      schedule = this.previewSchedule(duration, songToClock);
      preview = {
        start: Math.max(schedule.incomingStart, now),
        offset:
          schedule.incomingOffset + Math.max(0, now - schedule.incomingStart),
      };
    }

    const clockToSong = (t: number) =>
      running ? this.live.toMediaTime(t) : position + ((t - now) * rate);
    const window = schedule
      ? {
          start: clockToSong(schedule.automation.incomingGain[0].time),
          end: clockToSong(schedule.end),
        }
      : null;

    // Beat analysis is the costly part; refresh it once a second.
    const wall = performance.now();
    if (!this.overlayCache || wall - this.overlayCache.at > 1000) {
      const analysis = this.live.analyzeRecent(OUTGOING_ANALYSIS_SECONDS);
      let outgoing: OverlaySnapshot['outgoing'] = null;
      if (analysis) {
        const toSong = (t: number) => this.live.toMediaTime(t);
        const predicted: number[] = [];
        const { grid } = analysis;
        const last = analysis.beats.at(-1);
        if (grid && last !== undefined && window) {
          for (
            let k = Math.round((last - grid.origin) / grid.period) + 1;
            ;
            k++
          ) {
            const t = toSong(grid.origin + (k * grid.period));
            if (!(t <= window.end + 2) || predicted.length > 400) break;
            predicted.push(t);
          }
        }
        const phrases: number[] = [];
        const phraseGrid = this.outgoingPhraseGrid(analysis);
        if (phraseGrid && duration) {
          const { anchor, length } = phraseGrid;
          for (let k = Math.ceil(-anchor / length); anchor + (k * length) <= duration; k++) {
            phrases.push(anchor + (k * length));
          }
        }
        outgoing = {
          analysis,
          beats: analysis.beats.map(toSong),
          predicted,
          phrases,
        };
      }
      this.overlayCache = { at: wall, outgoing };
    }

    const startedAt = running?.startedAt ?? preview?.start ?? Number.NaN;
    const startOffset = running?.startOffset ?? preview?.offset ?? 0;
    const levels = schedule?.automation;
    return {
      status: this.status,
      state: this.state,
      position,
      duration,
      window,
      profile: currentId ? this.live.profileFor(currentId) : undefined,
      outgoing: this.overlayCache.outgoing,
      incoming: this.prepared
        ? {
            ...this.prepared.analysis,
            timeAt: (s: number) => {
              const t = songToClock(s);
              return t < startedAt ? Number.NaN : startOffset + (t - startedAt);
            },
            songAt: (t: number) => clockToSong(startedAt + (t - startOffset)),
          }
        : null,
      levelsAt: (s: number) => {
        if (!levels) return { out: 1, in: 0, outBass: 0, inBass: 0 };
        const t = songToClock(s);
        return {
          out: valueAt(levels.mainGain, t),
          in: valueAt(levels.incomingGain, t),
          outBass: valueAt(levels.mainBass, t),
          inBass: valueAt(levels.incomingBass, t),
        };
      },
      plan: this.plan,
      phraseTarget: this.phraseTarget,
    };
  }
}
