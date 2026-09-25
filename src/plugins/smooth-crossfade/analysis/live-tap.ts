import { analyzeFeatures, sliceFeatures, type TrackAnalysis } from './analyze';
import { FeatureExtractor, frameAt } from './features';
import { trackBeats } from './rhythm';

const PROCESSOR_NAME = 'smooth-crossfade-tap';
const BATCH_SAMPLES = 2048;

/**
 * Runs on the audio thread: mixes the player to mono and posts batches with
 * the audio-clock frame of their first sample. Loaded from a Blob URL so it
 * works both from the dev server and from the bundled build.
 */
const PROCESSOR_SOURCE = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${BATCH_SAMPLES});
    this.length = 0;
    this.start = 0;
    this.next = -1;
  }

  flush() {
    if (this.length === 0) return;
    const samples = this.buffer.slice(0, this.length);
    this.port.postMessage({ frame: this.start, samples }, [samples.buffer]);
    this.length = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      this.flush();
      this.next = -1;
      return true;
    }
    // A gap in the audio clock (suspend/resume) must not be glued together.
    if (this.length > 0 && currentFrame !== this.next) this.flush();
    if (this.length === 0) this.start = currentFrame;

    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < input.length; c++) sum += input[c][i];
      this.buffer[this.length + i] = sum / input.length;
    }
    this.length += n;
    this.next = currentFrame + n;
    if (this.length + n > this.buffer.length) this.flush();
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', Tap);
`;

/** Resolution of the per-song loudness profile. */
export const PROFILE_BUCKET_SECONDS = 0.05;
/** Profiles are cached so repeat plays show the whole song up front. */
const MAX_CACHED_PROFILES = 30;

/** A song's loudness over its whole length (dB per bucket, NaN = not heard). */
export type LoudnessProfile = { bucketSeconds: number; levels: Float32Array };

export type PlaybackInfo = {
  video: HTMLMediaElement;
  getTrackId: () => string | null;
  /** Position in the current song (s). */
  getPosition: () => number;
  getDuration: () => number | null;
};

type Segment = {
  extractor: FeatureExtractor;
  /** Song the segment belongs to, fixed by its first batch. */
  trackId: string | null;
  /**
   * Audio-clock → song-time mapping: from each breakpoint's `time` on, the
   * song advances `rate` seconds per second from `media`. Our own tempo
   * changes add breakpoints instead of restarting the segment.
   */
  breakpoints: { time: number; media: number; rate: number }[];
  /** Audio-clock time (s) of the segment's first sample. */
  startTime: number;
  /** Frame expected next, to detect gaps. */
  nextFrame: number;
  /** Nothing before this audio-clock time belongs to the segment. */
  notBefore: number;
};

/**
 * Continuously measures the playing song. Features are kept per "segment" of
 * uninterrupted playback; a seek, pause, rate change or new track starts a new
 * segment because the beat grid doesn't carry across them.
 *
 * All times are audio-clock seconds (`AudioContext.currentTime`), the same
 * clock the transition is scheduled in, so no media-time conversion is needed.
 */
export class LiveAnalyzer {
  private node: AudioWorkletNode | null = null;
  private segment: Segment | null = null;
  private moduleUrl: string | null = null;
  private readonly profiles = new Map<string, LoudnessProfile>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly input: AudioNode,
    private readonly playback: PlaybackInfo,
  ) {}

  async start() {
    const blob = new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' });
    this.moduleUrl = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(this.moduleUrl);

    // No outputs: it only listens. Nodes without outputs are still processed.
    this.node = new AudioWorkletNode(this.ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.node.port.onmessage = ({
      data,
    }: MessageEvent<{
      frame: number;
      samples: Float32Array;
    }>) => this.receive(data.frame, data.samples);
    this.input.connect(this.node);
    this.restart();
  }

  destroy() {
    if (this.node) {
      this.node.port.onmessage = null;
      try {
        this.input.disconnect(this.node);
      } catch {}
    }
    this.node = null;
    this.segment = null;
    if (this.moduleUrl) URL.revokeObjectURL(this.moduleUrl);
  }

  /** Start a fresh segment from now (call on seek/pause/track change). */
  restart() {
    const { video } = this.playback;
    this.segment = {
      extractor: new FeatureExtractor(this.ctx.sampleRate),
      trackId: null,
      breakpoints: [
        {
          time: this.ctx.currentTime,
          media: this.playback.getPosition(),
          rate: video.playbackRate || 1,
        },
      ],
      startTime: NaN,
      nextFrame: -1,
      notBefore: this.ctx.currentTime,
    };
  }

  /** Song position (s) of an audio-clock time in the current segment. */
  toMediaTime(time: number) {
    const segment = this.segment;
    if (!segment) return NaN;
    const { breakpoints } = segment;
    let bp = breakpoints[0];
    for (const candidate of breakpoints)
      if (candidate.time <= time) bp = candidate;
    return bp.media + ((time - bp.time) * bp.rate);
  }

  /** Audio-clock time at which the song reaches `media` at the current rate. */
  fromMediaTime(media: number) {
    const bp = this.segment?.breakpoints.at(-1);
    if (!bp) return NaN;
    return bp.time + ((media - bp.media) / bp.rate);
  }

  /** We changed the playback rate ourselves: keep measuring, remap time. */
  noteRateChange(rate: number) {
    const segment = this.segment;
    if (!segment) return;
    const time = this.ctx.currentTime;
    segment.breakpoints.push({ time, media: this.toMediaTime(time), rate });
  }

  /**
   * Beats (audio-clock times) since `from`, tracked at a tempo we already
   * know. Works on a few seconds of audio, e.g. right after a tempo ramp.
   */
  beatsSince(from: number, bpm: number): number[] {
    const segment = this.segment;
    if (!segment || Number.isNaN(segment.startTime)) return [];
    const features = segment.extractor.features(segment.startTime);
    const window = sliceFeatures(
      features,
      frameAt(features, from),
      features.length,
    );
    return trackBeats(window, bpm);
  }

  profileFor(trackId: string): LoudnessProfile | undefined {
    return this.profiles.get(trackId);
  }

  /** Seconds of uninterrupted audio measured in the current segment. */
  get seconds() {
    const segment = this.segment;
    if (!segment || Number.isNaN(segment.startTime)) return 0;
    return (segment.nextFrame / this.ctx.sampleRate) - segment.startTime;
  }

  /** Analysis of the last `seconds` of the current segment (audio-clock times). */
  analyzeRecent(seconds: number): TrackAnalysis | null {
    const segment = this.segment;
    if (!segment || Number.isNaN(segment.startTime)) return null;

    const features = segment.extractor.features(segment.startTime);
    const from = features.length - Math.round(seconds * features.frameRate);
    return analyzeFeatures(sliceFeatures(features, from, features.length));
  }

  private receive(frame: number, samples: Float32Array) {
    const segment = this.segment;
    if (!segment) return;

    const rate = this.ctx.sampleRate;
    let data = samples;
    let first = frame;
    const skip = Math.ceil((segment.notBefore * rate) - frame);
    if (skip >= data.length) return;
    if (skip > 0) {
      data = data.subarray(skip);
      first += skip;
    }

    if (segment.nextFrame !== -1 && first !== segment.nextFrame) {
      // The audio clock jumped (e.g. the context was suspended).
      this.restart();
      this.receive(frame, samples);
      return;
    }
    if (Number.isNaN(segment.startTime)) segment.startTime = first / rate;
    segment.extractor.push(data);
    segment.nextFrame = first + data.length;
    this.recordLevel(first / rate, data);
  }

  private recordLevel(time: number, data: Float32Array) {
    const trackId = this.playback.getTrackId();
    const duration = this.playback.getDuration();
    if (!trackId || !duration) return;

    // A gapless track change fires no media event, so notice it here.
    const segment = this.segment!;
    segment.trackId ??= trackId;
    if (segment.trackId !== trackId) {
      this.restart();
      return;
    }

    let profile = this.profiles.get(trackId);
    const buckets = Math.ceil(duration / PROFILE_BUCKET_SECONDS) + 1;
    if (!profile || profile.levels.length !== buckets) {
      profile = {
        bucketSeconds: PROFILE_BUCKET_SECONDS,
        levels: new Float32Array(buckets).fill(Number.NaN),
      };
      this.profiles.set(trackId, profile);
      if (this.profiles.size > MAX_CACHED_PROFILES) {
        this.profiles.delete(this.profiles.keys().next().value!);
      }
    }

    let energy = 0;
    for (const v of data) energy += v * v;
    const db = 10 * Math.log10((energy / data.length) + 1e-12);
    const bucket = Math.floor(this.toMediaTime(time) / PROFILE_BUCKET_SECONDS);
    if (bucket < 0 || bucket >= profile.levels.length) return;
    const previous = profile.levels[bucket];
    profile.levels[bucket] = Number.isNaN(previous)
      ? db
      : Math.max(previous, db);
  }
}
