/** Shrink the fade so short tracks still get a full-length track body. */
export const effectiveFadeSeconds = (
  configured: number,
  trackDuration: number,
) => Math.max(0, Math.min(configured, trackDuration / 2));
