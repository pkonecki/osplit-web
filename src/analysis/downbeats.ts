import { timeFrame } from "./onset";

/**
 * Metre and downbeats: bar starts are where the low end hits hardest (the
 * kick drum and bass usually land on beat one). For 3 and 4 beats per bar
 * and every phase, the mean low-band strength on the would-be downbeats is
 * compared with the mean over all beats.
 */

export type BeatsPerBar = 3 | 4;

/** 3/4 must beat 4/4 by this factor to be chosen (4/4 is far more common). */
const TRIPLE_MARGIN = 1.15;

export interface Metre {
  beatsPerBar: BeatsPerBar;
  /** Index of the first beat that starts a bar. */
  firstDownbeat: number;
}

/**
 * `beats` in seconds; `strength` an onset envelope of the low end (frames).
 */
export function estimateMetre(beats: ArrayLike<number>, strength: Float32Array): Metre {
  const values = Array.from(beats, (time) => peakNear(strength, timeFrame(time)));
  const best = (beatsPerBar: BeatsPerBar) => {
    let bestPhase = 0;
    let bestScore = -Infinity;
    for (let phase = 0; phase < beatsPerBar; phase++) {
      const value = phaseScore(values, beatsPerBar, phase);
      if (value > bestScore) {
        bestScore = value;
        bestPhase = phase;
      }
    }
    return { phase: bestPhase, score: bestScore };
  };
  const four = best(4);
  const three = best(3);
  return three.score > four.score * TRIPLE_MARGIN
    ? { beatsPerBar: 3, firstDownbeat: three.phase }
    : { beatsPerBar: 4, firstDownbeat: four.phase };
}

/** Mean strength on beats `phase`, `phase + n`, … over the mean on all beats. */
function phaseScore(values: number[], beatsPerBar: number, phase: number): number {
  let all = 0;
  for (const value of values) all += value;
  const mean = values.length ? all / values.length : 0;
  if (!(mean > 0)) return phase === 0 ? 1 : 0;
  let sum = 0;
  let count = 0;
  for (let i = phase; i < values.length; i += beatsPerBar) {
    sum += values[i];
    count++;
  }
  return count ? sum / count / mean : 0;
}

/** Largest value within two frames of `frame` (beats may be a frame off). */
function peakNear(envelope: Float32Array, frame: number): number {
  let peak = 0;
  for (let i = frame - 2; i <= frame + 2; i++) {
    if (i >= 0 && i < envelope.length) peak = Math.max(peak, envelope[i]);
  }
  return peak;
}
