import { frameTime } from "./onset";

/**
 * Beat tracking by dynamic programming (Ellis 2007, "Beat tracking by
 * dynamic programming"): each frame's best score is its onset strength plus
 * the best earlier beat's score, less a penalty for an interval far from the
 * global period. The best path follows tempo drift, as in live recordings.
 */

/** How strongly intervals are held to the global period. */
export const TIGHTNESS = 100;
/**
 * Flux peaks as an attack enters the analysis window, slightly before the
 * attack reaches its centre; measured on synthetic hits, this moves beats
 * onto the attacks.
 */
const ONSET_LAG_SECONDS = 0.009;

/**
 * Beat times (seconds) in `envelope` (normalised onset strength) around
 * `period` frames per beat.
 */
export function trackBeats(
  envelope: Float32Array,
  period: number,
  tightness = TIGHTNESS,
): Float64Array {
  const length = envelope.length;
  if (length === 0 || !(period > 1)) return new Float64Array();
  const local = localScore(envelope, period);
  let localMax = 0;
  for (const value of local) localMax = Math.max(localMax, value);
  if (!(localMax > 0)) return new Float64Array();

  const earliest = Math.round(2 * period);
  const latest = Math.max(1, Math.round(period / 2));
  // Penalty for each interval in [latest, earliest].
  const penalty = new Float64Array(earliest + 1);
  for (let gap = latest; gap <= earliest; gap++) {
    penalty[gap] = -tightness * Math.log(gap / period) ** 2;
  }
  const cumulative = new Float64Array(length);
  const backlink = new Int32Array(length).fill(-1);
  let started = false;
  for (let i = 0; i < length; i++) {
    let best = -Infinity;
    let bestFrom = -1;
    for (let gap = latest; gap <= earliest; gap++) {
      const from = i - gap;
      if (from < 0) break;
      const candidate = cumulative[from] + penalty[gap];
      if (candidate > best) {
        best = candidate;
        bestFrom = from;
      }
    }
    // Before the first real onset, no beat chain starts.
    if (!started && local[i] < 0.01 * localMax) {
      cumulative[i] = local[i];
      continue;
    }
    started = true;
    if (bestFrom >= 0 && best > 0) {
      cumulative[i] = local[i] + best;
      backlink[i] = bestFrom;
    } else {
      cumulative[i] = local[i];
    }
  }

  const last = lastBeat(cumulative);
  const frames: number[] = [];
  for (let frame = last; frame >= 0; frame = backlink[frame]) frames.push(frame);
  frames.reverse();
  return Float64Array.from(trimBeats(frames, local), refineFrameTime(local));
}

/** Onset strength smoothed by a Gaussian a thirty-second of a beat wide. */
function localScore(envelope: Float32Array, period: number): Float64Array {
  const radius = Math.max(1, Math.round(period));
  const kernel = new Float64Array(radius * 2 + 1);
  for (let k = -radius; k <= radius; k++) {
    kernel[k + radius] = Math.exp(-0.5 * ((k * 32) / period) ** 2);
  }
  const result = new Float64Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const index = i + k;
      if (index >= 0 && index < envelope.length) {
        sum += envelope[index] * kernel[k + radius];
      }
    }
    result[i] = sum;
  }
  return result;
}

/**
 * The last beat: the last local maximum of the cumulative score above half
 * the median of those maxima (a quiet ending doesn't hold beats).
 */
function lastBeat(cumulative: Float64Array): number {
  const maxima: number[] = [];
  for (let i = 1; i < cumulative.length - 1; i++) {
    if (cumulative[i] > cumulative[i - 1] && cumulative[i] >= cumulative[i + 1]) {
      maxima.push(i);
    }
  }
  if (cumulative.length > 1 && cumulative.at(-1)! > cumulative.at(-2)!) {
    maxima.push(cumulative.length - 1);
  }
  if (maxima.length === 0) return cumulative.length - 1;
  const values = maxima.map((i) => cumulative[i]).sort((a, b) => a - b);
  const threshold = 0.5 * values[Math.floor(values.length / 2)];
  for (let j = maxima.length - 1; j >= 0; j--) {
    if (cumulative[maxima[j]] > threshold) return maxima[j];
  }
  return maxima.at(-1)!;
}

/** Drops beats at either end where the music is quiet (before and after it). */
function trimBeats(frames: number[], local: Float64Array): number[] {
  if (frames.length === 0) return frames;
  let sum = 0;
  for (const frame of frames) sum += local[frame] ** 2;
  const threshold = 0.5 * Math.sqrt(sum / frames.length);
  let first = 0;
  let last = frames.length - 1;
  while (first <= last && local[frames[first]] < threshold) first++;
  while (last >= first && local[frames[last]] < threshold) last--;
  return frames.slice(first, last + 1);
}

/** A beat frame's time, refined between frames by a parabola on the score. */
function refineFrameTime(local: Float64Array): (frame: number) => number {
  return (frame) => {
    if (frame <= 0 || frame >= local.length - 1) {
      return frameTime(frame) + ONSET_LAG_SECONDS;
    }
    const a = local[frame - 1];
    const b = local[frame];
    const c = local[frame + 1];
    const curvature = a - 2 * b + c;
    const shift = curvature < 0
      ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature))
      : 0;
    return frameTime(frame + shift) + ONSET_LAG_SECONDS;
  };
}

/**
 * Tempo from beat times: the least-squares slope of time against beat
 * index, in beats per minute (the mean tempo of a drifting performance).
 */
export function beatsTempo(beats: ArrayLike<number>): number | null {
  const count = beats.length;
  if (count < 4) return null;
  let meanIndex = 0;
  let meanTime = 0;
  for (let i = 0; i < count; i++) {
    meanIndex += i;
    meanTime += beats[i];
  }
  meanIndex /= count;
  meanTime /= count;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < count; i++) {
    covariance += (i - meanIndex) * (beats[i] - meanTime);
    variance += (i - meanIndex) ** 2;
  }
  const secondsPerBeat = covariance / variance;
  return secondsPerBeat > 0 ? 60 / secondsPerBeat : null;
}
