/**
 * Timing that doesn't rely on `setTimeout`/`setInterval`. The Performance
 * Improvement plugin replaces those with versions that wait for an animation
 * frame, so while the window is unfocused they fire up to ~500 ms late. That
 * is fine for UI work but not for a handoff that must happen on time.
 */

/** Resolves on the next task, letting the page run in between. */
export const yieldToPage = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/**
 * Resolves when the audio clock reaches `when` (to within a render quantum,
 * ~3–10 ms). The event comes from the audio thread, so page timer throttling
 * doesn't delay it, and it naturally waits while the context is suspended.
 */
export const atAudioTime = (ctx: BaseAudioContext, when: number) =>
  new Promise<void>((resolve) => {
    const node = ctx.createConstantSource();
    node.offset.value = 0;
    // Unconnected sources may never be processed, so their `ended` never fires.
    node.connect(ctx.destination);
    node.onended = () => {
      node.disconnect();
      resolve();
    };
    const at = Math.max(when, ctx.currentTime);
    node.start(at);
    node.stop(at);
  });

export const audioDelay = (ctx: BaseAudioContext, seconds: number) =>
  atAudioTime(ctx, ctx.currentTime + seconds);
