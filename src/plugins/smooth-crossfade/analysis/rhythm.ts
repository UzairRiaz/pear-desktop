import { frameTime, type Features } from './features';

const MIN_BPM = 60;
const MAX_BPM = 200;
/** Tempo prior: log-normal around 120 BPM, one octave wide. */
const PRIOR_BPM = 120;
const PRIOR_OCTAVES = 1;
/** Ellis/librosa DP tightness: how strongly beats keep an even spacing. */
const TIGHTNESS = 100;
const MIN_SECONDS = 8;

export type TempoEstimate = {
  bpm: number;
  /** Autocorrelation at the beat period (0–1); higher is more periodic. */
  strength: number;
};

export type Grid = {
  /** Seconds per beat. */
  period: number;
  /** Time (s) of the grid's beat 0. */
  origin: number;
  /** RMS distance (ms) from detected beats to the straight grid. */
  residualMs: number;
  count: number;
};

export type Downbeats = {
  /** Beats per bar. */
  meter: 3 | 4;
  /** Index (into the beat list) of the first downbeat. */
  first: number;
  confidence: number;
};

const movingAverage = (x: Float32Array, radius: number) => {
  const out = new Float32Array(x.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < x.length + radius; i++) {
    if (i < x.length) {
      sum += x[i];
      count++;
    }
    if (i - (2 * radius) - 1 >= 0) {
      sum -= x[i - (2 * radius) - 1];
      count--;
    }
    const centre = i - radius;
    if (centre >= 0 && centre < x.length) out[centre] = sum / count;
  }
  return out;
};

/**
 * Onset envelope with slow loudness changes removed and unit variance, so a
 * song's quiet and loud sections weigh the same.
 */
export const normalizeOnset = (onset: Float32Array, frameRate: number) => {
  const trend = movingAverage(onset, Math.round(frameRate * 0.2));
  const out = new Float32Array(onset.length);
  let sumSq = 0;
  for (let i = 0; i < onset.length; i++) {
    out[i] = Math.max(0, onset[i] - trend[i]);
    sumSq += out[i] * out[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(1, onset.length)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= rms;
  return out;
};

const prior = (bpm: number) =>
  Math.exp(-0.5 * ((Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES) ** 2));

export const estimateTempo = (
  onset: Float32Array,
  frameRate: number,
): TempoEstimate | null => {
  if (onset.length < frameRate * MIN_SECONDS) return null;

  const x = new Float32Array(onset.length);
  let mean = 0;
  for (const v of onset) mean += v;
  mean /= onset.length;
  let variance = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] = onset[i] - mean;
    variance += x[i] * x[i];
  }
  variance /= x.length;
  if (variance <= 1e-12) return null;

  const minLag = Math.floor((frameRate * 60) / MAX_BPM);
  const maxLag = Math.ceil((frameRate * 60) / MIN_BPM);
  const ac = new Float32Array((2 * maxLag) + 2);
  for (let lag = 1; lag < ac.length && lag < x.length; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < x.length; i++) sum += x[i] * x[i + lag];
    ac[lag] = sum / (x.length - lag) / variance;
  }

  // Reward lags whose double is also periodic (a real beat repeats at 2×).
  const score = (lag: number) =>
    (ac[lag] + (0.5 * ac[2 * lag])) * prior((60 * frameRate) / lag);

  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (score(lag) > score(best)) best = lag;
  }

  // Parabolic interpolation for a sub-frame period.
  let lag = best;
  if (best > minLag && best < maxLag) {
    const a = score(best - 1);
    const b = score(best);
    const c = score(best + 1);
    const denominator = a - (2 * b) + c;
    if (denominator < 0) lag = best + ((0.5 * (a - c)) / denominator);
  }

  return {
    bpm: (60 * frameRate) / lag,
    strength: Math.max(0, Math.min(1, ac[best])),
  };
};

/**
 * Dynamic-programming beat tracker (Ellis 2007): picks onset peaks that are
 * as strong as possible while staying close to the given tempo. Returns beat
 * times in seconds.
 */
export const trackBeats = (features: Features, bpm: number): number[] => {
  const onset = normalizeOnset(features.onset, features.frameRate);
  const period = (60 * features.frameRate) / bpm;
  const n = onset.length;
  if (n === 0) return [];

  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const low = Math.max(1, Math.round(period / 2));
  const high = Math.round(period * 2);

  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let prev = Math.max(0, t - high); prev <= t - low; prev++) {
      const gap = Math.log((t - prev) / period);
      const value = score[prev] - (TIGHTNESS * gap * gap);
      if (value > best) {
        best = value;
        arg = prev;
      }
    }
    score[t] = onset[t] + best;
    back[t] = arg;
  }

  let last = Math.max(0, n - Math.round(period));
  for (let t = last; t < n; t++) if (score[t] > score[last]) last = t;

  const frames: number[] = [];
  for (let t = last; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();

  // Drop beats at either end that sit on no real onset: unmetered intros
  // (an alaap), fade-outs and silence would otherwise get an invented grid.
  const strength = (frame: number) => {
    let peak = 0;
    for (let i = frame - 2; i <= frame + 2; i++) {
      if (i >= 0 && i < n) peak = Math.max(peak, onset[i]);
    }
    return peak;
  };
  const sorted = frames.map(strength).sort((a, b) => a - b);
  const threshold = 0.3 * (sorted[Math.floor(sorted.length / 2)] ?? 0);
  let start = 0;
  let end = frames.length;
  const strongRun = (i: number, dir: 1 | -1) => {
    for (let k = 0; k < 4; k++) {
      const frame = frames[i + (k * dir)];
      if (frame === undefined || strength(frame) < threshold) return false;
    }
    return true;
  };
  while (start < end && !strongRun(start, 1)) start++;
  while (end > start && !strongRun(end - 1, -1)) end--;

  // Frames are ~11.6 ms apart; place each beat on its onset peak with
  // sub-frame precision so short windows still give an accurate tempo.
  const refine = (frame: number) => {
    let peak = frame;
    for (let i = frame - 2; i <= frame + 2; i++) {
      if (i > 0 && i < n - 1 && onset[i] > onset[peak]) peak = i;
    }
    if (peak <= 0 || peak >= n - 1) return peak;
    const a = onset[peak - 1];
    const b = onset[peak];
    const c = onset[peak + 1];
    const denominator = a - (2 * b) + c;
    return denominator < 0 ? peak + ((0.5 * (a - c)) / denominator) : peak;
  };

  return frames.slice(start, end).map((f) => frameTime(features, refine(f)));
};

const lineFit = (points: { k: number; t: number }[]) => {
  const n = points.length;
  const meanK = points.reduce((s, p) => s + p.k, 0) / n;
  const meanT = points.reduce((s, p) => s + p.t, 0) / n;
  let covariance = 0;
  let varianceK = 0;
  for (const p of points) {
    covariance += (p.k - meanK) * (p.t - meanT);
    varianceK += (p.k - meanK) ** 2;
  }
  const period = covariance / varianceK;
  const origin = meanT - (period * meanK);
  const residuals = points.map((p) => p.t - (origin + (period * p.k)));
  const rms = Math.sqrt(residuals.reduce((s, r) => s + (r * r), 0) / n);
  return { period, origin, residuals, rms };
};

/**
 * Straight grid through beats[from, to). Robust to the beat tracker's
 * occasional extra, missing or misplaced beat: beats are re-indexed by their
 * grid position and outliers are dropped before the final fit.
 */
export const fitGrid = (
  beats: number[],
  from = 0,
  to = beats.length,
): Grid | null => {
  if (to - from < 4) return null;

  const first = lineFit(beats.slice(from, to).map((t, k) => ({ k, t })));
  const indexed = beats.slice(from, to).map((t) => ({
    k: Math.round((t - first.origin) / first.period),
    t,
  }));
  let fit = lineFit(indexed);

  const limit = Math.max(0.015, 2.5 * fit.rms);
  const kept = indexed.filter((_, i) => Math.abs(fit.residuals[i]) <= limit);
  if (kept.length >= 4 && kept.length < indexed.length) fit = lineFit(kept);

  return {
    period: fit.period,
    // Grid index 0 is near beats[from]; beat i of the grid is at
    // `origin + period * i`.
    origin: fit.origin,
    residualMs: 1000 * fit.rms,
    count: kept.length >= 4 ? kept.length : indexed.length,
  };
};

/**
 * Finds which beats start bars. Kicks and chord changes land on downbeats,
 * so the beat phase (per candidate meter) with the most low-end onsets and
 * the biggest harmonic change wins.
 */
export const findDownbeats = (
  features: Features,
  beats: number[],
): Downbeats | null => {
  if (beats.length < 12) return null;

  const frameOf = (time: number) =>
    Math.round((time - features.timeOffset) * features.frameRate);

  const lowAt = beats.map((time) => {
    const frame = frameOf(time);
    let peak = 0;
    for (let i = frame - 2; i <= frame + 2; i++) {
      if (i >= 0 && i < features.length) {
        peak = Math.max(peak, features.lowOnset[i]);
      }
    }
    return peak;
  });

  const chromaBetween = (fromTime: number, toTime: number) => {
    const sum = new Float32Array(12);
    const from = Math.max(0, frameOf(fromTime));
    const to = Math.min(features.length, frameOf(toTime));
    for (let f = from; f < to; f++) {
      for (let p = 0; p < 12; p++) sum[p] += features.chroma[(f * 12) + p];
    }
    return sum;
  };
  const cosineDistance = (a: Float32Array, b: Float32Array) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let p = 0; p < 12; p++) {
      dot += a[p] * b[p];
      na += a[p] * a[p];
      nb += b[p] * b[p];
    }
    return na && nb ? 1 - (dot / Math.sqrt(na * nb)) : 0;
  };
  const harmonicChange = beats.map((time, i) => {
    if (i === 0 || i === beats.length - 1) return 0;
    return cosineDistance(
      chromaBetween(beats[i - 1], time),
      chromaBetween(time, beats[i + 1]),
    );
  });

  const zScore = (values: number[]) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd =
      Math.sqrt(
        values.reduce((a, b) => a + ((b - mean) ** 2), 0) / values.length,
      ) || 1;
    return values.map((v) => (v - mean) / sd);
  };
  const low = zScore(lowAt);
  const harmony = zScore(harmonicChange);

  const candidates: { meter: 3 | 4; phase: number; score: number }[] = [];
  for (const meter of [4, 3] as const) {
    for (let phase = 0; phase < meter; phase++) {
      let sum = 0;
      let count = 0;
      for (let i = phase; i < beats.length; i += meter) {
        sum += low[i] + (0.5 * harmony[i]);
        count++;
      }
      candidates.push({ meter, phase, score: sum / count });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  // Most music here is in 4; only pick 3 when it clearly wins.
  const best4 = candidates.find((c) => c.meter === 4)!;
  const best3 = candidates.find((c) => c.meter === 3)!;
  const winner = best3.score > best4.score + 0.25 ? best3 : best4;
  const runnerUp = candidates.find(
    (c) => c.meter === winner.meter && c.phase !== winner.phase,
  )!;

  return {
    meter: winner.meter,
    first: winner.phase,
    confidence: Math.max(0, Math.min(1, (winner.score - runnerUp.score) / 1.5)),
  };
};
