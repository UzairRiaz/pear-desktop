type Output = AudioNode | AudioParam;

/**
 * Routes both players through our crossfade gains while staying compatible
 * with other audio plugins (equalizer, compressor, visualizer, ...).
 *
 * Those plugins attach to the app's shared player source with
 * `audioSource.connect(...)`. If they kept doing that, a copy of the outgoing
 * song would bypass our gain and never fade out. So the source's real output
 * goes only to our own nodes, and every connect/disconnect made on the source
 * afterwards is redirected to a mix bus that carries both players:
 *
 *   source ─► mainInput ─► mainBass ─► mainGain ──────────┐
 *                              └─► echoSend ─► echo ─► echoOut ─┤
 *   incoming ─► incomingVolume ─► incomingBass ─► incomingGain ─┴─► mixBus
 *                                           mixBus ─► destination + plugins
 *
 * `mainInput` carries the main player at full level (before our fade), for
 * analysis taps. The player's volume is applied before the source node, so
 * `incomingVolume` mirrors it for the incoming song. The bass shelves do the
 * DJ "bass swap"; the echo is a tempo-synced feedback delay for echo-outs.
 *
 * This must be installed before any other plugin touches the source, while its
 * only output is the app's default connection to the destination.
 */
/** Where the bass shelf sits: kick drums and bass lines live below this. */
const BASS_SHELF_HZ = 180;
const ECHO_FEEDBACK = 0.45;

export class AudioGraph {
  readonly mainInput: GainNode;
  readonly mainBass: BiquadFilterNode;
  readonly mainGain: GainNode;
  readonly incomingVolume: GainNode;
  readonly incomingBass: BiquadFilterNode;
  readonly incomingGain: GainNode;
  readonly echoSend: GainNode;
  readonly echo: DelayNode;
  readonly mixBus: GainNode;

  private readonly outputs = new Set<Output>();

  constructor(
    readonly ctx: AudioContext,
    private readonly source: MediaElementAudioSourceNode,
  ) {
    const shelf = () => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowshelf';
      filter.frequency.value = BASS_SHELF_HZ;
      filter.gain.value = 0;
      return filter;
    };
    this.mainInput = ctx.createGain();
    this.mainBass = shelf();
    this.mainGain = ctx.createGain();
    this.incomingVolume = ctx.createGain();
    this.incomingBass = shelf();
    this.incomingGain = ctx.createGain();
    this.incomingGain.gain.value = 0;
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.echo = ctx.createDelay(4);
    const feedback = ctx.createGain();
    feedback.gain.value = ECHO_FEEDBACK;
    this.mixBus = ctx.createGain();

    source.disconnect();
    source.connect(this.mainInput);
    this.mainInput.connect(this.mainBass);
    this.mainBass.connect(this.mainGain);
    this.mainGain.connect(this.mixBus);
    // The echo is fed before mainGain, so it keeps ringing after the cut.
    this.mainBass.connect(this.echoSend);
    this.echoSend.connect(this.echo);
    this.echo.connect(feedback);
    feedback.connect(this.echo);
    this.echo.connect(this.mixBus);
    this.incomingVolume.connect(this.incomingBass);
    this.incomingBass.connect(this.incomingGain);
    this.incomingGain.connect(this.mixBus);
    this.mixBus.connect(ctx.destination);
    this.outputs.add(ctx.destination);

    const bus = this.mixBus as unknown as {
      connect: (...args: unknown[]) => unknown;
      disconnect: (...args: unknown[]) => unknown;
    };

    source.connect = ((destination: Output, ...rest: unknown[]) => {
      this.outputs.add(destination);
      return bus.connect(destination, ...rest);
    }) as typeof source.connect;

    source.disconnect = ((...args: unknown[]) => {
      const [first] = args;
      if (args.length === 0) {
        this.outputs.clear();
      } else if (
        args.length === 1 &&
        (first instanceof AudioNode || first instanceof AudioParam)
      ) {
        this.outputs.delete(first);
      }
      return bus.disconnect(...args);
    }) as typeof source.disconnect;
  }

  /** Put the source back the way other plugins expect to find it. */
  destroy() {
    const source = this.source as unknown as Record<string, unknown>;
    delete source.connect;
    delete source.disconnect;

    try {
      this.source.disconnect(this.mainInput);
    } catch {}
    for (const output of this.outputs) {
      try {
        if (output instanceof AudioNode) this.source.connect(output);
        else this.source.connect(output);
      } catch {}
    }

    for (const node of [
      this.mixBus,
      this.mainInput,
      this.mainBass,
      this.mainGain,
      this.incomingVolume,
      this.incomingBass,
      this.incomingGain,
      this.echoSend,
      this.echo,
    ]) {
      node.disconnect();
    }
    this.outputs.clear();
  }
}
