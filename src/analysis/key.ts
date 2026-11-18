import type { KeyEstimate, Modulation, MusicalKey } from "../types";
import { ALL_KEYS, sameKey } from "./spelling";

/**
 * Key: the summed chroma correlated with a profile of each of the 24 keys
 * (how often each scale degree sounds in music in that key).
 */

/** Kostka–Payne profiles (Temperley 2005), from C. */
const MAJOR_PROFILE = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4];
const MINOR_PROFILE = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33];

/** A best correlation at or below this is no key at all; well above, a clear one. */
const NO_KEY_CORRELATION = 0.35;
const CLEAR_KEY_CORRELATION = 0.75;
/** A lead this large over the runner-up counts fully. */
const CLEAR_MARGIN = 0.1;
/** Below this confidence the key is shown as unclear. */
export const KEY_UNCLEAR = 0.25;

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - meanA;
    const y = b[i] - meanB;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Correlation of a 12-bin chroma with each key in ALL_KEYS. */
export function keyCorrelations(chroma: ArrayLike<number>): number[] {
  const rotated = new Array<number>(12);
  return ALL_KEYS.map((key) => {
    const profile = key.mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
    for (let pc = 0; pc < 12; pc++) rotated[pc] = profile[(pc - key.tonic + 12) % 12];
    return pearson(chroma, rotated);
  });
}

/** The key of a summed chroma, or null when it is silent. */
export function estimateKey(chroma: ArrayLike<number>): KeyEstimate | null {
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (!(total > 0)) return null;
  const scores = keyCorrelations(chroma);
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const [best, second] = order;
  const clarity = clamp01((scores[best] - NO_KEY_CORRELATION) / (CLEAR_KEY_CORRELATION - NO_KEY_CORRELATION));
  const margin = clamp01((scores[best] - scores[second]) / CLEAR_MARGIN);
  return {
    ...ALL_KEYS[best],
    confidence: Math.round(clarity * (0.5 + 0.5 * margin) * 100) / 100,
    alternative: { ...ALL_KEYS[second] },
  };
}

/** Sum of segment chroma vectors, each weighted by its loudness (up to the median). */
export function sumChroma(
  vectors: Float32Array,
  energy: Float32Array,
  from = 0,
  to = energy.length,
): Float64Array {
  const typical = medianOf(energy);
  const sum = new Float64Array(12);
  for (let segment = from; segment < to; segment++) {
    const weight = typical > 0 ? Math.min(1, energy[segment] / typical) : 0;
    for (let pc = 0; pc < 12; pc++) sum[pc] += weight * vectors[segment * 12 + pc];
  }
  return sum;
}

/**
 * Key changes: the key of overlapping windows of about `windowSegments`
 * segments; a run of windows in one key lasting `minSegments` or more counts.
 * Returns the keys in time order (the first at 0), or undefined when the
 * song stays in one key.
 */
export function findModulations(
  vectors: Float32Array,
  energy: Float32Array,
  boundaries: ArrayLike<number>,
  windowSegments: number,
  minSegments: number,
): Modulation[] | undefined {
  const count = energy.length;
  if (count < minSegments * 2 || windowSegments < 4) return undefined;
  const hop = Math.max(1, Math.round(windowSegments / 4));
  // The local key at each segment: from the window centred on it.
  const local: (MusicalKey | null)[] = new Array(count).fill(null);
  for (let centre = 0; centre < count; centre += hop) {
    const from = Math.max(0, Math.min(count - windowSegments, centre - (windowSegments >> 1)));
    const key = estimateKey(sumChroma(vectors, energy, from, Math.min(count, from + windowSegments)));
    for (let i = centre; i < Math.min(count, centre + hop); i++) local[i] = key;
  }
  // Runs of one key; short ones join the run before them.
  const runs: { start: number; end: number; key: MusicalKey }[] = [];
  for (let i = 0; i < count; i++) {
    const key = local[i];
    if (!key) continue;
    const last = runs[runs.length - 1];
    if (last && sameKey(last.key, key)) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, key });
  }
  const held: typeof runs = [];
  for (const run of runs) {
    const last = held[held.length - 1];
    if (run.end - run.start < minSegments && last) {
      last.end = run.end;
    } else if (last && sameKey(last.key, run.key)) {
      last.end = run.end;
    } else {
      held.push({ ...run });
    }
  }
  if (held.length < 2) return undefined;
  // A short first run joins the next.
  if (held[0].end - held[0].start < minSegments) held.shift();
  if (held.length < 2) return undefined;
  return held.map((run, i) => ({
    start: i === 0 ? 0 : boundaries[run.start],
    tonic: run.key.tonic,
    mode: run.key.mode,
  }));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function medianOf(values: Float32Array): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[sorted.length >> 1];
}
