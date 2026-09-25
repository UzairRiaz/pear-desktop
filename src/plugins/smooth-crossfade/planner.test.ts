import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PLANNER_SETTINGS, planTransition } from './planner';

import type { TrackAnalysis } from './analysis/analyze';

const track = (
  bpm: number,
  beatConfidence = 0.9,
  camelot = '8B',
  keyConfidence = 0.8,
): TrackAnalysis => ({
  span: 60,
  tempo: { bpm, strength: 0.5 },
  beats: [],
  grid: { period: 60 / bpm, origin: 0, residualMs: 3, count: 100 },
  localResidualMs: 3,
  downbeats: null,
  beatConfidence,
  confidenceParts: {},
  key: {
    tonic: 0,
    mode: camelot.endsWith('B') ? 'major' : 'minor',
    name: '',
    camelot,
    confidence: keyConfidence,
  },
  loudness: { medianDb: -20, firstSound: 0, lastSound: 60 },
});

describe('planTransition', () => {
  it('beat-matches close tempos by stretching the outgoing song', () => {
    const plan = planTransition(track(120), track(124));
    assert.equal(plan.style, 'beatmatch');
    if (plan.style !== 'beatmatch') return;
    assert.ok(Math.abs(plan.outgoingRate - (124 / 120)) < 1e-9);
    assert.equal(plan.beatRatio, 1);
  });

  it('matches half and double time', () => {
    const plan = planTransition(track(170), track(86));
    assert.equal(plan.style, 'beatmatch');
    if (plan.style !== 'beatmatch') return;
    assert.equal(plan.beatRatio, 2);
    assert.ok(Math.abs(plan.outgoingRate - (172 / 170)) < 1e-9);

    const other = planTransition(track(80), track(158));
    assert.equal(other.style, 'beatmatch');
    if (other.style === 'beatmatch') assert.equal(other.beatRatio, 0.5);
  });

  it('echoes out when confident tempos are too far apart', () => {
    const plan = planTransition(track(100), track(110));
    assert.equal(plan.style, 'echo');
    assert.match(plan.reason, /too far/);
  });

  it('picks the blend length from confidence and keys', () => {
    const long = planTransition(track(120, 0.9), track(121, 0.8));
    const normal = planTransition(track(120, 0.6), track(121, 0.9));
    const clash = planTransition(track(120), track(121, 0.9, '3A'));
    assert.equal(long.style === 'beatmatch' && long.beats, 32);
    assert.equal(normal.style === 'beatmatch' && normal.beats, 16);
    assert.equal(clash.style === 'beatmatch' && clash.beats, 8);
  });

  it('respects a custom limit', () => {
    const settings = { ...DEFAULT_PLANNER_SETTINGS, maxTempoChange: 0.1 };
    assert.equal(
      planTransition(track(100), track(108), settings).style,
      'beatmatch',
    );
    assert.equal(
      planTransition(track(100), track(112), settings).style,
      'echo',
    );
    assert.equal(
      planTransition(track(100), track(101), { ...settings, maxTempoChange: 0 })
        .style,
      'crossfade',
    );
  });

  it('needs confident beats on both songs', () => {
    assert.equal(
      planTransition(track(120, 0.3), track(120)).style,
      'crossfade',
    );
    assert.equal(
      planTransition(track(120), track(120, 0.3)).style,
      'crossfade',
    );
    assert.equal(planTransition(null, track(120)).style, 'crossfade');
  });

  it('ignores keys when harmonic mixing is off', () => {
    const settings = { ...DEFAULT_PLANNER_SETTINGS, harmonicMixing: false };
    const plan = planTransition(track(120), track(120, 0.9, '3A'), settings);
    assert.equal(plan.keysCompatible, null);
    assert.equal(plan.style === 'beatmatch' && plan.beats, 32);
  });

  it('reports key compatibility only when both keys are confident', () => {
    assert.equal(
      planTransition(track(120), track(120, 0.9, '9B')).keysCompatible,
      true,
    );
    assert.equal(
      planTransition(track(120), track(120, 0.9, '3A')).keysCompatible,
      false,
    );
    assert.equal(
      planTransition(track(120), track(120, 0.9, '3A', 0.1)).keysCompatible,
      null,
    );
  });
});
