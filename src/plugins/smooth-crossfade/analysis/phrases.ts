import { frameAt, type Features } from './features';

/** Phrases are this many bars long (the usual unit for pop, EDM, hip-hop). */
const PHRASE_BARS = 8;
/** Bars compared on each side of a candidate boundary. */
const WINDOW_BARS = 4;

export type Phrases = {
  /** Beats per phrase (8 bars). */
  beatsPerPhrase: number;
  /** Indices (into the beat list) where phrases start. */
  starts: number[];
  /** 0–1: how clearly the music changes on this phrase grid. */
  confidence: number;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const zScore = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd =
    Math.sqrt(values.reduce((a, b) => a + ((b - mean) ** 2), 0) / values.length) ||
    1;
  return values.map((v) => (v - mean) / sd);
};

/**
 * Finds where phrases (8-bar sections) start. Songs change at phrase
 * boundaries: new chords, instruments, loudness. For every beat, the music in
 * the 4 bars before is compared with the 4 bars after; those differences peak
 * at section changes, and the phrase grid is the 8-bar phase where they peak
 * most consistently.
 */
export const findPhrases = (
  features: Features,
  beats: number[],
  meter = 4,
): Phrases | null => {
  const period = meter * PHRASE_BARS;
  const window = meter * WINDOW_BARS;
  const n = beats.length - 1;
  if (n < (2 * window) + period) return null;

  // One feature vector per beat: loudness, bass and onset activity, harmony.
  const loudness: number[] = [];
  const bass: number[] = [];
  const activity: number[] = [];
  const harmony: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.min(
      features.length - 1,
      Math.max(0, frameAt(features, beats[i])),
    );
    const to = Math.min(features.length, Math.max(from + 1, frameAt(features, beats[i + 1])));
    let db = 0;
    let low = 0;
    let onset = 0;
    const chroma = new Float32Array(12);
    for (let f = from; f < to; f++) {
      db += features.rmsDb[f];
      low += features.lowOnset[f];
      onset += features.onset[f];
      for (let p = 0; p < 12; p++) chroma[p] += features.chroma[(f * 12) + p];
    }
    const frames = to - from;
    loudness.push(db / frames);
    bass.push(low / frames);
    activity.push(onset / frames);
    let norm = 0;
    for (const v of chroma) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    harmony.push(chroma.map((v) => v / norm));
  }
  const scalars = [zScore(loudness), zScore(bass), zScore(activity)];

  const meanOver = (from: number, to: number) => {
    const mean = new Float32Array(3 + 12);
    for (let i = from; i < to; i++) {
      for (let s = 0; s < 3; s++) mean[s] += scalars[s][i];
      for (let p = 0; p < 12; p++) mean[3 + p] += 2 * harmony[i][p];
    }
    return mean.map((v) => v / (to - from));
  };

  // Novelty at each beat: how different the next 4 bars are from the last 4.
  const novelty = new Float32Array(n).fill(Number.NaN);
  for (let i = window; i + window <= n; i++) {
    const before = meanOver(i - window, i);
    const after = meanOver(i, i + window);
    let distance = 0;
    for (let k = 0; k < before.length; k++) distance += (after[k] - before[k]) ** 2;
    novelty[i] = Math.sqrt(distance);
  }
  // A change spreads novelty over several bars around it; keep only the
  // local peaks (within 2 bars) so each section change counts once.
  const reach = 2 * meter;
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = novelty[i];
    if (Number.isNaN(v)) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - reach); j <= Math.min(n - 1, i + reach); j++) {
      if (j !== i && novelty[j] > v) isPeak = false;
    }
    if (isPeak) peaks[i] = v;
  }
  // Allow a beat of slack either side (beat tracking isn't perfect).
  const peakNear = (i: number) => {
    let best = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
      best = Math.max(best, peaks[j]);
    }
    return best;
  };

  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(novelty[i])) valid.push(i);
  const scores: number[] = [];
  for (let phase = 0; phase < period; phase++) {
    let sum = 0;
    let count = 0;
    for (const i of valid) {
      if (i % period !== phase) continue;
      sum += peakNear(i);
      count++;
    }
    scores.push(count ? sum / count : 0);
  }

  // The slack makes a peak's neighbours tie with it; break ties with the
  // exact (no slack) peak values so the boundary isn't a beat early.
  const exact = (phase: number) =>
    valid.filter((i) => i % period === phase).reduce((sum, i) => sum + peaks[i], 0);
  let best = 0;
  for (let phase = 1; phase < period; phase++) {
    const better = scores[phase] > scores[best] + 1e-9;
    const tie = Math.abs(scores[phase] - scores[best]) <= 1e-9;
    if (better || (tie && exact(phase) > exact(best))) best = phase;
  }
  // How much the winner stands out from the other phases (its immediate
  // neighbours share its peaks through the slack, so they don't count)…
  const rivals = scores.filter((_, phase) => {
    const d = Math.abs(phase - best);
    return Math.min(d, period - d) >= 2;
  });
  const mean = rivals.reduce((a, b) => a + b, 0) / rivals.length;
  const sd =
    Math.sqrt(rivals.reduce((a, b) => a + ((b - mean) ** 2), 0) / rivals.length) ||
    1e-9;
  const z = (scores[best] - mean) / sd;
  // …and how big the changes there are compared with the music's usual
  // bar-to-bar variation. A loop can win by chance; real sections are big.
  const sorted = valid.map((i) => novelty[i]).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] || 1e-9;
  const atBoundaries = valid
    .filter((i) => i % period === best)
    .map((i) => novelty[i]);
  const ratio =
    atBoundaries.reduce((a, b) => a + b, 0) / Math.max(1, atBoundaries.length) / typical;

  const starts: number[] = [];
  for (let i = best; i < beats.length; i += period) starts.push(i);

  return {
    beatsPerPhrase: period,
    starts,
    confidence: clamp01((z - 1.5) / 2.5) * clamp01((ratio - 1.3) / 1.2),
  };
};
