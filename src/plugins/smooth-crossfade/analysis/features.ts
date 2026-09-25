import { magnitudeSpectrum } from './fft';

/** ~11.6 ms between frames: fine enough to place beats to within a few ms. */
export const HOP_SECONDS = 0.0116;

const BAND_COUNT = 48;
const MIN_BAND_HZ = 30;
const MAX_BAND_HZ = 11_000;
/** Kick-drum range, used to find downbeats. */
const LOW_BAND_MAX_HZ = 150;
/** Pitches C2–B6 (five whole octaves) feed the chroma. */
const CHROMA_MIN_MIDI = 36;
const CHROMA_MAX_MIDI = 95;
const LOG_COMPRESSION = 1000;

/** Per-frame audio features; frame `i` is centred at `timeOf(i)` seconds. */
export type Features = {
  frameRate: number;
  /** Stream time (s) of frame 0's centre; later frames follow every hop. */
  timeOffset: number;
  length: number;
  /** Spectral flux over all bands: how much new sound starts in this frame. */
  onset: Float32Array;
  /** Spectral flux below ~150 Hz (kick drums, bass notes). */
  lowOnset: Float32Array;
  rmsDb: Float32Array;
  /** 12 pitch-class energies per frame, C first. */
  chroma: Float32Array;
};

export const frameTime = (features: Features, frame: number) =>
  features.timeOffset + (frame / features.frameRate);

export const frameAt = (features: Features, time: number) =>
  Math.round((time - features.timeOffset) * features.frameRate);

class Growable {
  data: Float32Array;
  length = 0;

  constructor(private readonly width = 1) {
    this.data = new Float32Array(1024 * width);
  }

  reserve() {
    if ((this.length + 1) * this.width > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    return this.length++ * this.width;
  }

  view() {
    return this.data.slice(0, this.length * this.width);
  }
}

/**
 * Streaming feature extractor: push mono samples in any chunk size, read the
 * features accumulated so far. Used the same way for a decoded buffer and for
 * the live player tap, so both songs are measured identically.
 */
export class FeatureExtractor {
  readonly fftSize: number;
  readonly hop: number;

  private pending: Float32Array;
  private pendingLength = 0;
  private framesDone = 0;

  private readonly window: Float32Array;
  private readonly frame: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly spectrum: Float32Array;
  private readonly binBand: Int16Array;
  /** Per pitch: FFT bins, their kernel weights, and a normalising factor. */
  private readonly pitchKernels: {
    pitchClass: number;
    bins: Uint16Array;
    weights: Float32Array;
  }[] = [];
  private readonly lowBandCount: number;
  private readonly bands = new Float32Array(BAND_COUNT);
  private readonly previousBands = new Float32Array(BAND_COUNT);

  private readonly onset = new Growable();
  private readonly lowOnset = new Growable();
  private readonly rmsDb = new Growable();
  private readonly chroma = new Growable(12);

  constructor(readonly sampleRate: number) {
    this.fftSize = sampleRate > 32_000 ? 2048 : 1024;
    this.hop = Math.round(sampleRate * HOP_SECONDS);
    this.pending = new Float32Array(this.fftSize * 8);

    this.window = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.window[i] = 0.5 - (0.5 * Math.cos((2 * Math.PI * i) / this.fftSize));
    }
    this.frame = new Float32Array(this.fftSize);
    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);
    this.spectrum = new Float32Array((this.fftSize / 2) + 1);

    // Log-spaced bands; bins outside the range are ignored.
    const bins = this.spectrum.length;
    const maxHz = Math.min(MAX_BAND_HZ, sampleRate / 2);
    const ratio = Math.log(maxHz / MIN_BAND_HZ);
    this.binBand = new Int16Array(bins).fill(-1);
    let lowBands = 0;
    for (let bin = 1; bin < bins; bin++) {
      const hz = (bin * sampleRate) / this.fftSize;
      if (hz >= MIN_BAND_HZ && hz < maxHz) {
        const band = Math.min(
          BAND_COUNT - 1,
          Math.floor((Math.log(hz / MIN_BAND_HZ) / ratio) * BAND_COUNT),
        );
        this.binBand[bin] = band;
        if (hz < LOW_BAND_MAX_HZ) lowBands = Math.max(lowBands, band + 1);
      }
    }
    this.lowBandCount = Math.max(1, lowBands);

    // Each pitch is a triangular kernel over nearby bins. At low pitches one
    // bin spans several semitones, so the kernel widens to at least a bin.
    // Weights are normalised so pink noise (the rough spectral slope of
    // music) reads as a flat chroma; otherwise pitch classes that happen to
    // line up with more bass bins would win, biasing the key.
    const binHz = sampleRate / this.fftSize;
    for (let midi = CHROMA_MIN_MIDI; midi <= CHROMA_MAX_MIDI; midi++) {
      const centre = 440 * (2 ** ((midi - 69) / 12));
      const halfWidth = Math.max(centre * ((2 ** (1 / 12)) - 1), binHz);
      const binList: number[] = [];
      const weightList: number[] = [];
      let pinkResponse = 0;
      const firstBin = Math.max(1, Math.floor((centre - halfWidth) / binHz));
      const lastBin = Math.min(
        bins - 1,
        Math.ceil((centre + halfWidth) / binHz),
      );
      for (let bin = firstBin; bin <= lastBin; bin++) {
        const weight = 1 - (Math.abs((bin * binHz) - centre) / halfWidth);
        if (weight <= 0) continue;
        binList.push(bin);
        weightList.push(weight);
        pinkResponse += weight / Math.sqrt(bin * binHz);
      }
      if (!pinkResponse) continue;
      this.pitchKernels.push({
        pitchClass: midi % 12,
        bins: Uint16Array.from(binList),
        weights: Float32Array.from(weightList, (w) => w / pinkResponse),
      });
    }
  }

  get frameRate() {
    return this.sampleRate / this.hop;
  }

  push(samples: Float32Array) {
    let offset = 0;
    while (offset < samples.length) {
      const space = this.pending.length - this.pendingLength;
      const take = Math.min(space, samples.length - offset);
      this.pending.set(
        samples.subarray(offset, offset + take),
        this.pendingLength,
      );
      this.pendingLength += take;
      offset += take;

      let consumed = 0;
      while (this.pendingLength - consumed >= this.fftSize) {
        this.processFrame(
          this.pending.subarray(consumed, consumed + this.fftSize),
        );
        consumed += this.hop;
      }
      this.pending.copyWithin(0, consumed, this.pendingLength);
      this.pendingLength -= consumed;
    }
  }

  /** Features so far. `streamStart` is the stream time of the first sample. */
  features(streamStart = 0): Features {
    return {
      frameRate: this.frameRate,
      timeOffset: streamStart + (this.fftSize / 2 / this.sampleRate),
      length: this.framesDone,
      onset: this.onset.view(),
      lowOnset: this.lowOnset.view(),
      rmsDb: this.rmsDb.view(),
      chroma: this.chroma.view(),
    };
  }

  private processFrame(input: Float32Array) {
    let energy = 0;
    for (let i = 0; i < this.fftSize; i++) {
      energy += input[i] * input[i];
      this.frame[i] = input[i] * this.window[i];
    }
    magnitudeSpectrum(this.frame, this.re, this.im, this.spectrum);

    this.bands.fill(0);
    const chromaIndex = this.chroma.reserve();
    const chroma = this.chroma.data;
    const scale = 2 / this.fftSize;
    for (let bin = 1; bin < this.spectrum.length; bin++) {
      const magnitude = this.spectrum[bin] * scale;
      const band = this.binBand[bin];
      if (band >= 0) this.bands[band] += magnitude;
    }
    for (const kernel of this.pitchKernels) {
      let energy = 0;
      for (let i = 0; i < kernel.bins.length; i++) {
        energy += this.spectrum[kernel.bins[i]] * kernel.weights[i];
      }
      chroma[chromaIndex + kernel.pitchClass] += energy * scale;
    }

    let flux = 0;
    let lowFlux = 0;
    for (let band = 0; band < BAND_COUNT; band++) {
      const level = Math.log1p(LOG_COMPRESSION * this.bands[band]);
      const rise = Math.max(0, level - this.previousBands[band]);
      flux += rise;
      if (band < this.lowBandCount) lowFlux += rise;
      this.previousBands[band] = level;
    }

    // The first frame has no predecessor, so its flux is meaningless.
    this.onset.data[this.onset.reserve()] = this.framesDone === 0 ? 0 : flux;
    this.lowOnset.data[this.lowOnset.reserve()] =
      this.framesDone === 0 ? 0 : lowFlux;
    this.rmsDb.data[this.rmsDb.reserve()] =
      10 * Math.log10((energy / this.fftSize) + 1e-12);
    this.framesDone++;
  }
}

/** Features for a whole decoded buffer (all channels mixed to mono). */
export const extractFeatures = (buffer: {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
}) => {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) {
      mono[i] += data[i] / buffer.numberOfChannels;
    }
  }

  const extractor = new FeatureExtractor(buffer.sampleRate);
  extractor.push(mono);
  return extractor.features();
};
