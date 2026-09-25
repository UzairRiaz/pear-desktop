import { keysCompatible, type TrackAnalysis } from './analysis/analyze';

export type PlannerSettings = {
  /** Largest tempo change applied to the outgoing song, e.g. 0.06 = ±6%. */
  maxTempoChange: number;
  /** Both songs need at least this beat confidence to be beat-matched. */
  minBeatConfidence: number;
  /** Consider keys when choosing the blend length. */
  harmonicMixing: boolean;
  /** Blend length in beats, or 'auto' to choose from confidence and keys. */
  blendBeats: 'auto' | 8 | 16 | 32;
};

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  maxTempoChange: 0.06,
  minBeatConfidence: 0.5,
  harmonicMixing: true,
  blendBeats: 'auto',
};

/** Keys only count when both are confidently detected. */
const MIN_KEY_CONFIDENCE = 0.3;
/** Both songs this sure of their beat get the long, club-style blend. */
const LONG_BLEND_CONFIDENCE = 0.7;

type Common = {
  reason: string;
  outBpm: number | null;
  inBpm: number | null;
  /** null when either key is uncertain. */
  keysCompatible: boolean | null;
};

export type TransitionPlan =
  | (Common & {
      style: 'beatmatch';
      /** playbackRate for the outgoing song so its beats match the incoming. */
      outgoingRate: number;
      /** Outgoing beats per incoming beat (0.5, 1 or 2: half/double time). */
      beatRatio: number;
      /** Blend length in incoming beats. */
      beats: number;
    })
  | (Common & { style: 'echo' })
  | (Common & { style: 'crossfade' });

const bpmOf = (analysis: TrackAnalysis | null) =>
  analysis?.grid ? 60 / analysis.grid.period : null;

export const planTransition = (
  outgoing: TrackAnalysis | null,
  incoming: TrackAnalysis | null,
  settings: PlannerSettings = DEFAULT_PLANNER_SETTINGS,
): TransitionPlan => {
  const outBpm = bpmOf(outgoing);
  const inBpm = bpmOf(incoming);

  const outKey = outgoing?.key;
  const inKey = incoming?.key;
  const keys =
    settings.harmonicMixing &&
    outKey &&
    inKey &&
    outKey.confidence >= MIN_KEY_CONFIDENCE &&
    inKey.confidence >= MIN_KEY_CONFIDENCE
      ? keysCompatible(outKey.camelot, inKey.camelot)
      : null;

  const common = { outBpm, inBpm, keysCompatible: keys };
  const crossfade = (reason: string): TransitionPlan => ({
    style: 'crossfade',
    reason,
    ...common,
  });

  if (!outgoing || !incoming || !outBpm || !inBpm) {
    return crossfade('no tempo for one of the songs');
  }
  if (settings.maxTempoChange <= 0) return crossfade('beat-matching is off');

  const { minBeatConfidence } = settings;
  if (outgoing.beatConfidence < minBeatConfidence) {
    return crossfade(
      `outgoing beat unsure (${outgoing.beatConfidence.toFixed(2)})`,
    );
  }
  if (incoming.beatConfidence < minBeatConfidence) {
    return crossfade(
      `incoming beat unsure (${incoming.beatConfidence.toFixed(2)})`,
    );
  }

  // Match at the same tempo, or half/double time, whichever needs the
  // smallest change.
  let best = { rate: Infinity, beatRatio: 1 };
  for (const beatRatio of [0.5, 1, 2]) {
    const rate = (inBpm * beatRatio) / outBpm;
    if (Math.abs(rate - 1) < Math.abs(best.rate - 1))
      best = { rate, beatRatio };
  }

  const change = best.rate - 1;
  if (Math.abs(change) > settings.maxTempoChange) {
    // Both beats are solid, just too far apart to blend: cut on the beat.
    return {
      style: 'echo',
      reason: `tempos too far apart to blend (${outBpm.toFixed(1)} → ${inBpm.toFixed(1)} BPM, ${(change * 100).toFixed(1)}%)`,
      ...common,
    };
  }

  // Clashing keys sound bad for long, so keep that overlap short.
  const beats =
    settings.blendBeats !== 'auto'
      ? settings.blendBeats
      : keys === false
        ? 8
        : Math.min(outgoing.beatConfidence, incoming.beatConfidence) >=
            LONG_BLEND_CONFIDENCE
          ? 32
          : 16;

  return {
    style: 'beatmatch',
    reason: `${outBpm.toFixed(1)} → ${inBpm.toFixed(1)} BPM, outgoing ${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%, ${beats} beats${keys === false ? ' (keys clash)' : ''}`,
    outgoingRate: best.rate,
    beatRatio: best.beatRatio,
    beats,
    ...common,
  };
};
