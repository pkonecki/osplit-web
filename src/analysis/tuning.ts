import { CHROMA_WINDOW, forEachSpectrum } from "./chroma";
import { ANALYSIS_RATE } from "./onset";

/**
 * Tuning: how far the track sits from A = 440 Hz, in cents. Spectral peaks
 * across the track each deviate from the nearest equal-tempered pitch; their
 * circular mean (weighted by loudness) is the offset, within ±50 cents. A
 * song at A = 432 Hz reads as about −32.
 */

const MIN_HZ = 150;
const MAX_HZ = 2000;
/** Peaks quieter than this fraction of the frame's loudest are ignored. */
const PEAK_FLOOR = 0.1;
/** Every n-th chroma frame is enough. */
const FRAME_STEP = 4;

export function estimateTuning(samples: Float32Array): number {
  const binHz = ANALYSIS_RATE / CHROMA_WINDOW;
  const lowBin = Math.ceil(MIN_HZ / binHz);
  const highBin = Math.floor(MAX_HZ / binHz);
  let x = 0;
  let y = 0;
  forEachSpectrum(samples, CHROMA_WINDOW, (_, magnitudes) => {
    let loudest = 0;
    for (let bin = lowBin; bin <= highBin; bin++) loudest = Math.max(loudest, magnitudes[bin]);
    if (!(loudest > 1e-3)) return;
    for (let bin = lowBin; bin <= highBin; bin++) {
      const b = magnitudes[bin];
      if (b < loudest * PEAK_FLOOR || b < magnitudes[bin - 1] || b <= magnitudes[bin + 1]) continue;
      // Parabola through the log magnitudes around the peak.
      const a = Math.log(magnitudes[bin - 1] + 1e-12);
      const c = Math.log(magnitudes[bin + 1] + 1e-12);
      const m = Math.log(b);
      const curvature = a - 2 * m + c;
      const offset = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature)) : 0;
      const cents = 1200 * Math.log2(((bin + offset) * binHz) / 440);
      const angle = (2 * Math.PI * cents) / 100;
      x += b * Math.cos(angle);
      y += b * Math.sin(angle);
    }
  }, FRAME_STEP);
  if (x === 0 && y === 0) return 0;
  return Math.round((Math.atan2(y, x) / (2 * Math.PI)) * 100 * 10) / 10;
}
