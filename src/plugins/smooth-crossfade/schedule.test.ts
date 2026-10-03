import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASS_CUT_DB,
  beatmatchSchedule,
  crossfadeSchedule,
  echoSchedule,
  valueAt,
} from './schedule';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

describe('valueAt', () => {
  it('holds before, ramps between and holds after keyframes', () => {
    const frames = [
      { time: 1, value: 0 },
      { time: 3, value: 1 },
    ];
    close(valueAt(frames, 0), 0);
    close(valueAt(frames, 2), 0.5);
    close(valueAt(frames, 9), 1);
  });
});

describe('crossfadeSchedule', () => {
  it('keeps the combined power steady', () => {
    const s = crossfadeSchedule({ start: 10, fade: 6 });
    for (let t = 10; t <= 16; t += 0.37) {
      const out = valueAt(s.automation.mainGain, t);
      const incoming = valueAt(s.automation.incomingGain, t);
      // Linear interpolation between 16 curve points is within 1% of exact.
      close((out * out) + (incoming * incoming), 1, 0.02);
    }
    assert.equal(s.end, 16);
    assert.equal(s.incomingStart, 10);
  });
});

describe('beatmatchSchedule', () => {
  const beat = 0.5;
  const s = beatmatchSchedule({
    entry: 100,
    incomingDownbeat: 2.3,
    beatSeconds: beat,
    beats: 16,
  });

  it('starts the buffer so its downbeat lands on the entry', () => {
    close(s.incomingStart + 2.3, 100);
    close(s.end, 108);
  });

  it('never plays both basslines at full at once', () => {
    for (let t = 99; t <= 109; t += 0.05) {
      const main = valueAt(s.automation.mainBass, t);
      const incoming = valueAt(s.automation.incomingBass, t);
      // During the one-beat swap both are partly cut; otherwise one is fully cut.
      assert.ok(
        main + incoming <= (BASS_CUT_DB / 2) + 1e-9 || (t > 104 && t < 104.5),
        `t=${t.toFixed(2)}: ${main} + ${incoming}`,
      );
    }
    close(valueAt(s.automation.incomingBass, 103.9), BASS_CUT_DB);
    close(valueAt(s.automation.incomingBass, 104.5), 0);
    close(valueAt(s.automation.mainBass, 104.5), BASS_CUT_DB);
  });

  it('fades the incoming in over the first quarter and the outgoing out over the second half', () => {
    close(valueAt(s.automation.incomingGain, 99.9), 0);
    close(valueAt(s.automation.incomingGain, 102), 1);
    close(valueAt(s.automation.mainGain, 104), 1);
    close(valueAt(s.automation.mainGain, 108), 0, 1e-6);
  });
});

describe('keeping intros', () => {
  it('fades a beat-matched incoming song in from its very start', () => {
    const s = beatmatchSchedule({
      entry: 100,
      incomingDownbeat: 3,
      beatSeconds: 0.5,
      beats: 16,
      keepIntro: true,
    });
    close(s.incomingStart, 97);
    close(valueAt(s.automation.incomingGain, 96.98), 0);
    assert.ok(valueAt(s.automation.incomingGain, 98) > 0.2, 'intro is audible');
    close(valueAt(s.automation.incomingGain, 102), 1);
  });

  it('fades an echo-out incoming song in from its start', () => {
    const s = echoSchedule({
      cut: 50,
      beatSeconds: 0.5,
      barBeats: 4,
      incomingDownbeat: 1,
      keepIntro: true,
    });
    close(s.incomingStart, 51);
    assert.ok(valueAt(s.automation.incomingGain, 51.5) > 0.2, 'intro is audible');
    close(valueAt(s.automation.incomingGain, 52), 1);
  });

  it('leaves the default behaviour unchanged', () => {
    const s = beatmatchSchedule({ entry: 100, incomingDownbeat: 3, beatSeconds: 0.5, beats: 16 });
    close(valueAt(s.automation.incomingGain, 99.9), 0);
  });
});

describe('echoSchedule', () => {
  it('cuts on the downbeat and brings the incoming in a bar later', () => {
    const s = echoSchedule({
      cut: 50,
      beatSeconds: 0.5,
      barBeats: 4,
      incomingDownbeat: 1,
    });
    close(s.end, 52);
    close(s.incomingStart, 51);
    close(valueAt(s.automation.mainGain, 50.5), 0);
    close(valueAt(s.automation.echoSend, 50.2), 1);
    close(valueAt(s.automation.echoSend, 51), 0);
    close(valueAt(s.automation.incomingGain, 51.9), 0);
    close(valueAt(s.automation.incomingGain, 52.1), 1);
  });
});
