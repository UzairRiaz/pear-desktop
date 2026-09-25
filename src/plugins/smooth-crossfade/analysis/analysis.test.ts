/**
 * Synthetic-signal tests for the analysis library. Run with:
 *   node tools/smooth-crossfade-tests.mjs
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeFeatures, fitGrid, sliceFeatures } from './analyze';
import { extractFeatures, FeatureExtractor } from './features';
import { camelotOf, keysCompatible } from './key';

const SR = 44_100;

/** Deterministic noise so failures reproduce. */
const makeRandom = (seed: number) => () => {
  seed = ((seed * 1_664_525) + 1_013_904_223) % 4_294_967_296;
  return ((seed / 4_294_967_296) * 2) - 1;
};

const addKick = (out: Float32Array, at: number) => {
  const start = Math.round(at * SR);
  for (let i = 0; i < SR * 0.12 && start + i < out.length; i++) {
    const t = i / SR;
    const freq = 50 + (90 * Math.exp(-t * 40));
    out[start + i] +=
      0.8 * Math.exp(-t * 25) * Math.sin(2 * Math.PI * freq * t);
  }
};

const addNoise = (
  out: Float32Array,
  at: number,
  seconds: number,
  gain: number,
  random: () => number,
) => {
  const start = Math.round(at * SR);
  let previous = 0;
  for (let i = 0; i < SR * seconds && start + i < out.length; i++) {
    const noise = random();
    // First difference: tilts the noise towards highs, like a hi-hat.
    out[start + i] += gain * Math.exp(-(i / SR) * 60) * (noise - previous);
    previous = noise;
  }
};

const addTone = (
  out: Float32Array,
  from: number,
  to: number,
  hz: number,
  gain: number,
) => {
  const start = Math.round(from * SR);
  const end = Math.min(out.length, Math.round(to * SR));
  for (let i = start; i < end; i++) {
    const t = (i - start) / SR;
    const envelope =
      Math.min(1, t * 200) * Math.min(1, (end - i) / (SR * 0.005));
    let v = 0;
    for (let h = 1; h <= 3; h++)
      v += Math.sin(2 * Math.PI * hz * h * (i / SR)) / h;
    out[i] += gain * envelope * v;
  }
};

type DrumOptions = {
  bpm: number;
  seconds?: number;
  meter?: 3 | 4;
  /** Random per-hit timing error (ms), like a live drummer. */
  jitterMs?: number;
  leadSilence?: number;
  seed?: number;
};

/** Returns the audio and the true beat and downbeat times. */
const drumTrack = ({
  bpm,
  seconds = 40,
  meter = 4,
  jitterMs = 0,
  leadSilence = 0,
  seed = 1,
}: DrumOptions) => {
  const out = new Float32Array(SR * seconds);
  const random = makeRandom(seed);
  const period = 60 / bpm;
  const beats: number[] = [];
  const bassNotes = [55, 73.42, 65.41, 82.41];

  for (let k = 0; ; k++) {
    const t = leadSilence + (k * period) + ((random() * jitterMs) / 1000);
    if (t + period > seconds) break;
    beats.push(t);
    const inBar = k % meter;
    if (inBar === 0) {
      addKick(out, t);
      // A bass note per bar: the harmonic change marks the downbeat.
      const bar = Math.floor(k / meter);
      addTone(out, t, t + (period * meter), bassNotes[bar % 4], 0.15);
    } else if (meter === 4 && inBar === 2) {
      addKick(out, t);
    }
    if (meter === 4 && inBar % 2 === 1) addNoise(out, t, 0.12, 0.35, random);
    addNoise(out, t, 0.04, 0.2, random);
  }

  return {
    audio: out,
    beats,
    downbeats: beats.filter((_, k) => k % meter === 0),
  };
};

const toBuffer = (audio: Float32Array) => ({
  sampleRate: SR,
  numberOfChannels: 1,
  length: audio.length,
  getChannelData: () => audio,
});

const analyse = (audio: Float32Array) =>
  analyzeFeatures(extractFeatures(toBuffer(audio)));

/** Offset (s) of each detected beat to the nearest true beat. */
const beatErrors = (detected: number[], truth: number[]) =>
  detected.map((t) => {
    let best = Infinity;
    for (const u of truth) if (Math.abs(t - u) < Math.abs(best)) best = t - u;
    return best;
  });

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

describe('tempo and beats', () => {
  for (const bpm of [80, 95, 110, 128, 140]) {
    it(`finds ${bpm} BPM and its beats`, () => {
      const { audio, beats } = drumTrack({ bpm });
      const result = analyse(audio);

      assert.ok(result.tempo, 'no tempo');
      const ratio = result.tempo.bpm / bpm;
      assert.ok(
        Math.abs(ratio - 1) < 0.01,
        `tempo ${result.tempo.bpm.toFixed(2)}`,
      );

      const errors = beatErrors(result.beats, beats);
      assert.ok(
        result.beats.length > beats.length * 0.9,
        `only ${result.beats.length} of ${beats.length} beats`,
      );
      // A constant detection delay is fine (both songs share it); spread isn't.
      assert.ok(
        Math.abs(mean(errors)) < 0.03,
        `mean offset ${(mean(errors) * 1000).toFixed(1)}ms`,
      );
      assert.ok(
        sd(errors) < 0.006,
        `beat spread ${(sd(errors) * 1000).toFixed(1)}ms`,
      );
      assert.ok(
        result.localResidualMs < 6,
        `residual ${result.localResidualMs.toFixed(1)}ms`,
      );
      assert.ok(
        result.beatConfidence > 0.7,
        `confidence ${result.beatConfidence.toFixed(2)}`,
      );
    });
  }

  it('gets the tempo precise enough to beat-match from 16 beats', () => {
    for (const bpm of [87, 100, 123.5, 140]) {
      const { audio } = drumTrack({ bpm });
      const { beats } = analyse(audio);
      // 0.03% drifts < 5 ms across a 32-beat blend.
      for (const [from, to] of [
        [0, 16],
        [0, beats.length],
      ]) {
        const grid = fitGrid(beats, from, to)!;
        const error = Math.abs((60 / grid.period / bpm) - 1);
        assert.ok(
          error < 0.0003,
          `${bpm} BPM beats ${from}-${to}: ${(error * 100).toFixed(3)}% off`,
        );
      }
    }
  });

  it('reports the detection delay consistently across tempos', () => {
    const offsets = [90, 120, 150].map((bpm) => {
      const { audio, beats } = drumTrack({ bpm });
      return mean(beatErrors(analyse(audio).beats, beats));
    });
    assert.ok(
      Math.max(...offsets) - Math.min(...offsets) < 0.004,
      offsets.map((o) => (o * 1000).toFixed(1)).join(', '),
    );
  });

  it('has low confidence on noise', () => {
    const random = makeRandom(7);
    const audio = new Float32Array(SR * 30).map(() => random() * 0.3);
    assert.ok(analyse(audio).beatConfidence < 0.2);
  });

  it('has lower confidence for a sloppy live drummer', () => {
    const tight = analyse(drumTrack({ bpm: 100 }).audio);
    const loose = analyse(drumTrack({ bpm: 100, jitterMs: 50, seed: 3 }).audio);
    assert.ok(
      loose.localResidualMs > tight.localResidualMs + 5,
      `${tight.localResidualMs.toFixed(1)} vs ${loose.localResidualMs.toFixed(1)}`,
    );
    assert.ok(loose.beatConfidence < tight.beatConfidence);
  });

  it('distrusts a drifting tempo', () => {
    // Speeds up 4% over the track, like a live band pushing the tempo.
    const seconds = 40;
    const audio = new Float32Array(SR * seconds);
    let t = 0.5;
    for (let k = 0; t < seconds - 1; k++) {
      addKick(audio, t);
      t += 60 / (100 * (1 + (0.04 * (t / seconds))));
    }
    const result = analyse(audio);
    assert.ok(
      result.beatConfidence < 0.3,
      `confidence ${result.beatConfidence.toFixed(2)} (${JSON.stringify(result.confidenceParts)})`,
    );
  });

  it('ignores a leading silence', () => {
    const { audio, beats } = drumTrack({ bpm: 120, leadSilence: 3 });
    const result = analyse(audio);
    assert.ok(
      Math.abs(result.loudness.firstSound - 3) < 0.1,
      `first sound ${result.loudness.firstSound}`,
    );
    assert.ok(
      result.beats[0] > beats[0] - 0.1,
      `first beat ${result.beats[0]}`,
    );
  });
});

describe('downbeats', () => {
  it('finds bar starts in 4/4', () => {
    const { audio, downbeats } = drumTrack({ bpm: 118 });
    const result = analyse(audio);
    assert.ok(result.downbeats, 'no downbeats');
    assert.equal(result.downbeats.meter, 4);
    const detected = result.beats.filter(
      (_, i) =>
        i >= result.downbeats!.first && (i - result.downbeats!.first) % 4 === 0,
    );
    const errors = beatErrors(detected, downbeats);
    assert.ok(
      errors.every((e) => Math.abs(e) < 0.05),
      'downbeats land off the bar starts',
    );
  });

  it('recognises 3/4', () => {
    const { audio } = drumTrack({ bpm: 132, meter: 3 });
    const result = analyse(audio);
    assert.equal(result.downbeats?.meter, 3);
  });
});

describe('key', () => {
  const progression = (chords: number[][], seconds = 2) => {
    const audio = new Float32Array(SR * chords.length * seconds * 2);
    for (let rep = 0; rep < 2; rep++) {
      chords.forEach((chord, i) => {
        const at = ((rep * chords.length) + i) * seconds;
        for (const midi of chord) {
          addTone(audio, at, at + seconds, 440 * (2 ** ((midi - 69) / 12)), 0.1);
        }
      });
    }
    return audio;
  };

  it('detects C major', () => {
    const audio = progression([
      [60, 64, 67],
      [65, 69, 72],
      [67, 71, 74],
      [60, 64, 67],
    ]);
    const result = analyse(audio);
    assert.equal(result.key?.name, 'C');
    assert.equal(result.key?.camelot, '8B');
  });

  it('detects A minor', () => {
    const audio = progression([
      [57, 60, 64],
      [62, 65, 69],
      [64, 68, 71],
      [57, 60, 64],
    ]);
    const result = analyse(audio);
    assert.equal(result.key?.camelot, '8A');
  });

  it('has no key preference on noise', () => {
    // Pink noise: every pitch class equal, no confident key.
    const random = makeRandom(9);
    const audio = new Float32Array(SR * 20);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < audio.length; i++) {
      const white = random();
      b0 = (0.99765 * b0) + (white * 0.099);
      b1 = (0.963 * b1) + (white * 0.2965);
      b2 = (0.57 * b2) + (white * 1.0527);
      audio[i] = (b0 + b1 + b2 + (white * 0.1848)) * 0.05;
    }
    const features = extractFeatures(toBuffer(audio));
    const chroma = new Array<number>(12).fill(0);
    for (let f = 0; f < features.length; f++) {
      for (let p = 0; p < 12; p++) chroma[p] += features.chroma[(f * 12) + p];
    }
    const spread = Math.max(...chroma) / Math.min(...chroma);
    assert.ok(spread < 1.05, `chroma spread ${spread.toFixed(3)}`);
    assert.ok((analyzeFeatures(features).key?.confidence ?? 0) < 0.2);
  });

  it('maps the Camelot wheel', () => {
    assert.equal(camelotOf(0, 'major'), '8B');
    assert.equal(camelotOf(7, 'major'), '9B');
    assert.equal(camelotOf(11, 'major'), '1B');
    assert.equal(camelotOf(9, 'minor'), '8A');
    assert.equal(camelotOf(4, 'minor'), '9A');
    assert.ok(keysCompatible('8A', '8B'));
    assert.ok(keysCompatible('12B', '1B'));
    assert.ok(!keysCompatible('8A', '9B'));
    assert.ok(!keysCompatible('3A', '8A'));
  });
});

describe('feature extractor', () => {
  it('gives the same result for any chunking', () => {
    const { audio } = drumTrack({ bpm: 100, seconds: 10 });
    const whole = extractFeatures(toBuffer(audio));
    const streamed = new FeatureExtractor(SR);
    const random = makeRandom(5);
    for (let i = 0; i < audio.length; ) {
      const size = 1 + Math.floor((random() + 1) * 3000);
      streamed.push(audio.subarray(i, i + size));
      i += size;
    }
    const features = streamed.features();
    assert.equal(features.length, whole.length);
    for (let i = 0; i < whole.length; i++) {
      assert.ok(Math.abs(features.onset[i] - whole.onset[i]) < 1e-4);
    }
  });

  it('slices keep absolute times', () => {
    const { audio, beats } = drumTrack({ bpm: 120, seconds: 40 });
    const features = extractFeatures(toBuffer(audio));
    const half = sliceFeatures(
      features,
      Math.round(features.frameRate * 15),
      features.length,
    );
    const result = analyzeFeatures(half);
    const errors = beatErrors(result.beats, beats);
    assert.ok(result.beats[0] > 14.5);
    assert.ok(sd(errors) < 0.006);
  });
});
