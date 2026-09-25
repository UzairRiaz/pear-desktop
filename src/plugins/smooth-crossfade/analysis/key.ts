import type { Features } from './features';

// Krumhansl–Kessler key profiles, tonic first.
const MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export type KeyEstimate = {
  /** Tonic pitch class, 0 = C. */
  tonic: number;
  mode: 'major' | 'minor';
  name: string;
  /** Camelot wheel code, e.g. "8B" (C major) or "8A" (A minor). */
  camelot: string;
  confidence: number;
};

const correlation = (a: number[], b: number[]) => {
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] - meanA) * (b[i] - meanB);
    na += (a[i] - meanA) ** 2;
    nb += (b[i] - meanB) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export const camelotOf = (tonic: number, mode: 'major' | 'minor') => {
  // Minor keys sit on the same number as their relative major (3 semitones up).
  const majorTonic = mode === 'major' ? tonic : (tonic + 3) % 12;
  const number = (((majorTonic * 7) + 7) % 12) + 1;
  return `${number}${mode === 'major' ? 'B' : 'A'}`;
};

/** Same key, relative major/minor, or one step round the wheel. */
export const keysCompatible = (a: string, b: string) => {
  const numberA = Number.parseInt(a, 10);
  const numberB = Number.parseInt(b, 10);
  const letterA = a.at(-1);
  const letterB = b.at(-1);
  if (numberA === numberB) return true;
  const step = Math.min(
    (numberA - numberB + 12) % 12,
    (numberB - numberA + 12) % 12,
  );
  return step === 1 && letterA === letterB;
};

export const estimateKey = (
  features: Features,
  from = 0,
  to = features.length,
): KeyEstimate | null => {
  const profile = new Array<number>(12).fill(0);
  for (let f = from; f < to; f++) {
    // Loud frames count more; near-silent ones barely at all.
    const weight = Math.max(0, features.rmsDb[f] + 60) / 60;
    for (let p = 0; p < 12; p++) {
      profile[p] += features.chroma[(f * 12) + p] * weight;
    }
  }
  if (profile.every((v) => v === 0)) return null;

  const scores: { tonic: number; mode: 'major' | 'minor'; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = profile.map((_, i) => profile[(i + tonic) % 12]);
    scores.push({ tonic, mode: 'major', r: correlation(rotated, MAJOR) });
    scores.push({ tonic, mode: 'minor', r: correlation(rotated, MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);

  const [best, second] = scores;
  // Relative major/minor share a Camelot number, so they don't count as rivals.
  const rival =
    scores.find(
      (s) =>
        camelotOf(s.tonic, s.mode).slice(0, -1) !==
        camelotOf(best.tonic, best.mode).slice(0, -1),
    ) ?? second;

  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${NAMES[best.tonic]}${best.mode === 'minor' ? 'm' : ''}`,
    camelot: camelotOf(best.tonic, best.mode),
    confidence: Math.max(0, Math.min(1, (best.r - rival.r) * 4)),
  };
};
