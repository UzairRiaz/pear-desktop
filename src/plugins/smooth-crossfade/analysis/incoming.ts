import { analyzeFeatures, type TrackAnalysis } from './analyze';
import { FeatureExtractor } from './features';

import { yieldToPage } from '../timers';

/** Seconds of audio analysed between yields to the page (~12 ms of work). */
const CHUNK_SECONDS = 2;

/**
 * Analyses a decoded buffer without blocking the page: extraction (the
 * expensive part) runs in small chunks, yielding between them.
 */
export type BufferAnalysis = {
  analysis: TrackAnalysis;
  /** Loudness (dB) per analysis frame, for drawing. */
  envelope: Float32Array;
  frameRate: number;
  /** Time (s) of the envelope's first frame. */
  envelopeStart: number;
};

export const analyzeBuffer = async (
  buffer: AudioBuffer,
  isCancelled: () => boolean = () => false,
): Promise<BufferAnalysis | null> => {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) {
      mono[i] += data[i] / buffer.numberOfChannels;
    }
  }

  const extractor = new FeatureExtractor(buffer.sampleRate);
  const chunk = Math.round(buffer.sampleRate * CHUNK_SECONDS);
  for (let i = 0; i < mono.length; i += chunk) {
    extractor.push(mono.subarray(i, i + chunk));
    await yieldToPage();
    if (isCancelled()) return null;
  }
  const features = extractor.features();
  return {
    analysis: analyzeFeatures(features),
    envelope: features.rmsDb,
    frameRate: features.frameRate,
    envelopeStart: features.timeOffset,
  };
};
