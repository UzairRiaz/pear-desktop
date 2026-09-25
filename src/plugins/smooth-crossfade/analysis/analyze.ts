import { frameTime, type Features } from './features';
import { estimateKey, type KeyEstimate } from './key';
import {
  estimateTempo,
  findDownbeats,
  fitGrid,
  trackBeats,
  type Downbeats,
  type Grid,
  type TempoEstimate,
} from './rhythm';

export { extractFeatures, FeatureExtractor, type Features } from './features';
export { camelotOf, keysCompatible, type KeyEstimate } from './key';
export { fitGrid, type Downbeats, type Grid } from './rhythm';

/** Audio this far below the song's median loudness counts as silence. */
const SILENCE_BELOW_MEDIAN_DB = 20;
/** Beats per window when measuring how steady the tempo is. */
const LOCAL_GRID_BEATS = 16;

export type TrackAnalysis = {
  /** Seconds of audio analysed. */
  span: number;
  tempo: TempoEstimate | null;
  /** Beat times (s, in the features' time base). */
  beats: number[];
  /** Straight grid fitted through all beats. */
  grid: Grid | null;
  /** Median residual (ms) of 16-beat grids: low for steady, programmed tempo. */
  localResidualMs: number;
  downbeats: Downbeats | null;
  /** 0–1: how safe it is to beat-match this track. */
  beatConfidence: number;
  /** The factors multiplied into `beatConfidence`, for debugging. */
  confidenceParts: Record<string, number>;
  key: KeyEstimate | null;
  loudness: {
    medianDb: number;
    /** First/last time (s) the audio rises above the silence threshold. */
    firstSound: number;
    lastSound: number;
  };
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const sliceFeatures = (
  features: Features,
  from: number,
  to: number,
): Features => {
  const start = Math.max(0, Math.min(features.length, from));
  const end = Math.max(start, Math.min(features.length, to));
  return {
    frameRate: features.frameRate,
    timeOffset: frameTime(features, start),
    length: end - start,
    onset: features.onset.slice(start, end),
    lowOnset: features.lowOnset.slice(start, end),
    rmsDb: features.rmsDb.slice(start, end),
    chroma: features.chroma.slice(start * 12, end * 12),
  };
};

const median = (values: ArrayLike<number>) => {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const loudnessOf = (features: Features) => {
  const medianDb = median(features.rmsDb);
  const threshold = medianDb - SILENCE_BELOW_MEDIAN_DB;
  let first = 0;
  while (first < features.length && features.rmsDb[first] < threshold) first++;
  let last = features.length - 1;
  while (last > first && features.rmsDb[last] < threshold) last--;
  return {
    medianDb,
    firstSound: frameTime(features, first),
    lastSound: frameTime(features, Math.max(first, last)),
  };
};

const localResidual = (beats: number[]) => {
  const residuals: number[] = [];
  for (
    let i = 0;
    i + LOCAL_GRID_BEATS <= beats.length;
    i += LOCAL_GRID_BEATS / 2
  ) {
    const grid = fitGrid(beats, i, i + LOCAL_GRID_BEATS);
    if (grid) residuals.push(grid.residualMs);
  }
  return residuals.length ? median(residuals) : Infinity;
};

export const analyzeFeatures = (features: Features): TrackAnalysis => {
  const span = features.length / features.frameRate;
  const loudness = loudnessOf(features);
  const key = estimateKey(features);
  const tempo = estimateTempo(features.onset, features.frameRate);

  if (!tempo) {
    return {
      span,
      tempo,
      beats: [],
      grid: null,
      localResidualMs: Infinity,
      downbeats: null,
      beatConfidence: 0,
      confidenceParts: {},
      key,
      loudness,
    };
  }

  const beats = trackBeats(features, tempo.bpm);
  const grid = fitGrid(beats);
  const localResidualMs = localResidual(beats);
  const downbeats = findDownbeats(features, beats);

  const soundSpan = Math.max(1e-6, loudness.lastSound - loudness.firstSound);
  const beatSpan = beats.length > 1 ? beats.at(-1)! - beats[0] : 0;
  const periodicity = clamp01((tempo.strength - 0.05) / 0.25);
  const steadiness = clamp01((40 - localResidualMs) / 30);
  const coverage = clamp01(beatSpan / soundSpan);

  // The two halves of the track must agree. An octave apart is fine (the same
  // pulse counted at half or double speed), but 4:3 or 3:2 means the beat level
  // is ambiguous (triplet feels), and matching the wrong one sounds awful.
  const half = Math.floor(features.length / 2);
  let consistency = 1;
  for (const [from, to] of [
    [0, half],
    [half, features.length],
  ]) {
    const window = sliceFeatures(features, from, to);
    const local = estimateTempo(window.onset, window.frameRate);
    if (!local) continue;
    const ratio = local.bpm / tempo.bpm;
    const octaveReduced = ratio * (2 ** -Math.round(Math.log2(ratio)));
    if (Math.abs(octaveReduced - 1) > 0.02) consistency = 0.2;
  }

  // Live players drift; beat-matching assumes the tempo holds.
  let drift = 0;
  const middle = beats.length ? frameTime(features, half) : 0;
  const split = beats.findIndex((t) => t >= middle);
  const firstGrid = split > 0 ? fitGrid(beats, 0, split) : null;
  const secondGrid = split > 0 ? fitGrid(beats, split) : null;
  if (firstGrid && secondGrid) {
    drift = Math.abs((firstGrid.period / secondGrid.period) - 1);
  }
  const stability = clamp01((0.02 - drift) / 0.015);

  const confidenceParts = {
    periodicity,
    steadiness,
    coverage,
    consistency,
    stability,
  };

  return {
    span,
    tempo,
    beats,
    grid,
    localResidualMs,
    downbeats,
    beatConfidence: Object.values(confidenceParts).reduce((a, b) => a * b, 1),
    confidenceParts,
    key,
    loudness,
  };
};
