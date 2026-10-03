/**
 * Transition schedules: when the incoming song starts and how every gain, bass
 * shelf and echo send moves, as keyframes on the audio clock. Pure data, so
 * it can be tested, applied to AudioParams, and drawn by the overlay.
 */

/** Values move linearly between keyframes and hold before/after them. */
export type Keyframe = { time: number; value: number };

export type Automation = {
  mainGain: Keyframe[];
  incomingGain: Keyframe[];
  /** Bass shelf gain in dB (0 = untouched). */
  mainBass: Keyframe[];
  incomingBass: Keyframe[];
  echoSend: Keyframe[];
};

export type Schedule = {
  style: 'crossfade' | 'beatmatch' | 'echo';
  /** Audio-clock time the incoming buffer starts, from buffer time `offset`. */
  incomingStart: number;
  incomingOffset: number;
  /** The outgoing song is silent from here; the handoff can begin. */
  end: number;
  /** Echo delay (s) for echo-outs. */
  echoDelay?: number;
  automation: Automation;
};

/** Bass cut used for the swap, in dB. */
export const BASS_CUT_DB = -30;
const CURVE_STEPS = 16;

export const valueAt = (frames: Keyframe[], time: number) => {
  if (frames.length === 0) return Number.NaN;
  if (time <= frames[0].time) return frames[0].value;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (time <= b.time) {
      if (b.time === a.time) return b.value;
      return (
        a.value + ((b.value - a.value) * ((time - a.time) / (b.time - a.time)))
      );
    }
  }
  return frames.at(-1)!.value;
};

/** Keyframes tracing `curve(u)` for u in [0, 1] over [from, to]. */
const curve = (from: number, to: number, fn: (u: number) => number) =>
  Array.from({ length: CURVE_STEPS + 1 }, (_, i) => {
    const u = i / CURVE_STEPS;
    return { time: from + (u * (to - from)), value: fn(u) };
  });

const fadeOut = (u: number) => Math.cos((Math.PI * u) / 2);
const fadeIn = (u: number) => Math.sin((Math.PI * u) / 2);
const hold = (time: number, value: number): Keyframe[] => [{ time, value }];

/** The existing equal-power crossfade. */
export const crossfadeSchedule = ({
  start,
  fade,
  incomingOffset = 0,
}: {
  start: number;
  fade: number;
  incomingOffset?: number;
}): Schedule => ({
  style: 'crossfade',
  incomingStart: start,
  incomingOffset,
  end: start + fade,
  automation: {
    mainGain: curve(start, start + fade, fadeOut),
    incomingGain: curve(start, start + fade, fadeIn),
    mainBass: hold(start, 0),
    incomingBass: hold(start, 0),
    echoSend: hold(start, 0),
  },
});

/**
 * A DJ blend over `beats` beats starting on the downbeat at `entry`, where the
 * incoming song's downbeat at buffer time `incomingDownbeat` lands.
 *
 *   first quarter  incoming fades in with its bass cut
 *   midpoint       bass swap over one beat (no doubled kick drums)
 *   second half    outgoing fades out
 */
export const beatmatchSchedule = ({
  entry,
  incomingDownbeat,
  beatSeconds,
  beats,
  keepIntro = false,
}: {
  entry: number;
  incomingDownbeat: number;
  beatSeconds: number;
  beats: number;
  /** Fade the incoming song in from its start instead of from the entry. */
  keepIntro?: boolean;
}): Schedule => {
  const length = beats * beatSeconds;
  const middle = entry + (length / 2);
  const end = entry + length;
  const incomingStart = entry - incomingDownbeat;
  const fadeFrom = keepIntro ? Math.min(incomingStart, entry) : entry;
  return {
    style: 'beatmatch',
    incomingStart,
    incomingOffset: 0,
    end,
    automation: {
      incomingGain: [
        { time: fadeFrom - 0.01, value: 0 },
        ...curve(fadeFrom, entry + (length / 4), fadeIn),
      ],
      incomingBass: [
        { time: middle, value: BASS_CUT_DB },
        { time: middle + beatSeconds, value: 0 },
      ],
      mainBass: [
        { time: middle, value: 0 },
        { time: middle + beatSeconds, value: BASS_CUT_DB },
      ],
      mainGain: [{ time: middle, value: 1 }, ...curve(middle, end, fadeOut)],
      echoSend: hold(entry, 0),
    },
  };
};

/**
 * Echo-out: the outgoing song is cut on its downbeat at `cut` while one beat
 * of it feeds a tempo-synced echo, and the incoming song comes in on its
 * downbeat one bar later. For songs whose tempos are too far apart to blend.
 */
export const echoSchedule = ({
  cut,
  beatSeconds,
  barBeats,
  incomingDownbeat,
  keepIntro = false,
}: {
  cut: number;
  beatSeconds: number;
  barBeats: number;
  incomingDownbeat: number;
  /** Fade the incoming song in from its start instead of cutting in. */
  keepIntro?: boolean;
}): Schedule => {
  const entry = cut + (barBeats * beatSeconds);
  const incomingStart = entry - incomingDownbeat;
  const fadeFrom = keepIntro && incomingStart < entry - 0.05 ? incomingStart : null;
  return {
    style: 'echo',
    incomingStart,
    incomingOffset: 0,
    end: entry,
    echoDelay: beatSeconds * 0.75,
    automation: {
      echoSend: [
        { time: cut - 0.02, value: 0 },
        { time: cut, value: 1 },
        { time: cut + beatSeconds, value: 1 },
        { time: cut + (beatSeconds * 1.1), value: 0 },
      ],
      mainGain: [
        { time: cut, value: 1 },
        { time: cut + beatSeconds, value: 0 },
      ],
      incomingGain:
        fadeFrom === null
          ? [
              { time: entry - 0.02, value: 0 },
              { time: entry + 0.01, value: 1 },
            ]
          : [{ time: fadeFrom - 0.01, value: 0 }, ...curve(fadeFrom, entry, fadeIn)],
      mainBass: hold(cut, 0),
      incomingBass: hold(cut, 0),
    },
  };
};

/**
 * Applies keyframes to an AudioParam from `now` on: jumps to the current
 * value, then ramps linearly through the remaining keyframes.
 */
export const applyKeyframes = (
  param: AudioParam,
  frames: Keyframe[],
  now: number,
) => {
  param.cancelScheduledValues(0);
  param.setValueAtTime(valueAt(frames, now), now);
  for (const frame of frames) {
    if (frame.time > now)
      param.linearRampToValueAtTime(frame.value, frame.time);
  }
};
