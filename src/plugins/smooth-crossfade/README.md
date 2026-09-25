# Smooth Crossfade

DJ-style transitions between songs. For each pair it picks one of three styles:

| Style | When | What you hear |
| --- | --- | --- |
| Beat-matched blend | Both songs have a steady beat and tempos within the max tempo change (half/double time count) | The outgoing song's tempo ramps to the incoming one (pitch preserved), the incoming song enters on a downbeat, bass lines swap at the midpoint, the outgoing song fades out |
| Echo-out | Both beats are steady but the tempos are too far apart | The outgoing song is cut on its beat into a tempo-synced echo; the incoming song enters on its downbeat a bar later |
| Crossfade | No reliable beat (ambient, rubato, live recordings) | Equal-power crossfade, skipping the incoming song's leading silence |

Manual skips, the previous button and picking a song never transition. Consecutive tracks from one album are left gapless (configurable).

## Settings

Transition style (auto / crossfade only), max tempo change (off, ±3, ±6, ±10%), blend length (auto / 8 / 16 / 32 beats), bass swap, harmonic mixing (short blends when keys clash), crossfade duration, album rule, seekbar overlay, debug logging.

Hovering the seekbar shows an overlay with the current song's loudness, a zoomed view of the upcoming transition (both songs' loudness and beats, the gain and bass curves) and the planned style.

## How it works

1. **Preload** (~60s before the end): the main process fetches the first 1 MiB of the next song's audio (stream URLs only serve that much without a PO token, ~60s of audio) and the renderer decodes it into an `AudioBuffer`.
2. **Analysis** (`analysis/`): onset envelope, tempo, beat grid, downbeats, key (Camelot) and loudness, plus a 0–1 confidence for beat-matching. The incoming song is analysed from the buffer; the outgoing song continuously, from an AudioWorklet tap on the player.
3. **Plan** (`planner.ts`): picks the style and blend length from both analyses.
4. **Schedule** (`schedule.ts`): the transition as gain / bass-shelf / echo keyframes on the audio clock. The incoming buffer starts sample-accurately.
5. **Beat-match only**: tempo ramp, re-lock onto the outgoing beat, then a phase-locked loop during the blend that nudges the outgoing tempo to keep the beats together.
6. **Handoff**: when the outgoing song is silent, YT Music's player switches to the next song and is seeked to the buffer's position (re-seeking until within ~20 ms), then takes over.

Things that aren't obvious:

- The `<video>` element's clock is not the song's: in gapless playback YT Music appends the next song to the same stream. Song position and identity come from the player API (`ytm-adapter.ts`).
- The Performance Improvement plugin throttles `setTimeout`, so timing-critical steps run on the audio clock (`timers.ts`).
- Other audio plugins attach to the shared player source; `audio-graph.ts` redirects those connections to a mix bus so they process both songs and the fade can't be bypassed.

## Conflicts

Turn off the built-in **Crossfade** plugin and **Skip Silences** (it seeks during fades, which cancels them).

## Tests

```sh
node tools/smooth-crossfade-tests.mjs
```

Synthetic-signal tests for the analysis (tempo, beats, downbeats, key, drift), the planner and the schedules.
