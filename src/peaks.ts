/** Number of peak values kept per stem for its waveform. */
export const PEAK_BUCKETS = 2000;

/**
 * Builds a waveform overview of streamed 16-bit stereo audio: the track is
 * split into PEAK_BUCKETS equal parts, and each keeps its largest absolute
 * sample (0–1), over both channels.
 */
export class PeakBuilder {
  private readonly peaks: Float32Array;
  private readonly frameCount: number;
  private frame = 0;

  constructor(frameCount: number, buckets = PEAK_BUCKETS) {
    this.frameCount = Math.max(1, frameCount);
    this.peaks = new Float32Array(buckets);
  }

  /** Adds the next interleaved stereo samples. */
  push(interleaved: Int16Array): void {
    const buckets = this.peaks.length;
    for (let i = 0; i < interleaved.length; i += 2) {
      const bucket = Math.min(
        buckets - 1,
        Math.floor((this.frame * buckets) / this.frameCount),
      );
      const level = Math.max(
        Math.abs(interleaved[i]),
        Math.abs(interleaved[i + 1]),
      ) / 32768;
      if (level > this.peaks[bucket]) this.peaks[bucket] = level;
      this.frame++;
    }
  }

  result(): Float32Array {
    return this.peaks;
  }
}

/** The same overview, from decoded channels (samples in −1…1). */
export function peaksFromChannels(
  left: Float32Array,
  right: Float32Array,
  buckets = PEAK_BUCKETS,
): Float32Array {
  const peaks = new Float32Array(buckets);
  const frames = Math.max(1, left.length);
  for (let frame = 0; frame < left.length; frame++) {
    const bucket = Math.min(buckets - 1, Math.floor((frame * buckets) / frames));
    const level = Math.min(1, Math.max(Math.abs(left[frame]), Math.abs(right[frame])));
    if (level > peaks[bucket]) peaks[bucket] = level;
  }
  return peaks;
}
