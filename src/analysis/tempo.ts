import { FRAME_RATE } from "./onset";

/**
 * Global tempo from the onset envelope's autocorrelation, weighted by a
 * prior that favours tempos near 120 BPM.
 */

export const MIN_BPM = 50;
export const MAX_BPM = 220;
const PRIOR_CENTRE_BPM = 120;
/**
 * Width of the prior, in octaves. Narrower than a full octave, so a backbeat
 * (the snare on beats 2 and 4, often the strongest drum hit) reads as the
 * beat at 120 rather than at 60.
 */
const PRIOR_OCTAVES = 0.8;
/**
 * When the half period correlates almost as well as the chosen one, the
 * onsets repeat twice as fast: the faster tempo explains them better.
 */
const FASTER_OCTAVE_RATIO = 0.75;

export interface TempoEstimate {
  bpm: number;
  /** 0–1: how clearly the chosen period stands out. */
  confidence: number;
  /** The other likely octave (half or double), or null if none is plausible. */
  alternative: number | null;
}

export function bpmToLag(bpm: number): number {
  return (60 * FRAME_RATE) / bpm;
}

export function lagToBpm(lag: number): number {
  return (60 * FRAME_RATE) / lag;
}

/** Autocorrelation for lags 0…maxLag, each divided by its overlap length. */
export function autocorrelation(envelope: Float32Array, maxLag: number): Float64Array {
  const result = new Float64Array(maxLag + 1);
  const length = envelope.length;
  for (let lag = 0; lag <= maxLag && lag < length; lag++) {
    let sum = 0;
    for (let i = lag; i < length; i++) sum += envelope[i] * envelope[i - lag];
    result[lag] = sum / (length - lag);
  }
  return result;
}

export function estimateTempo(envelope: Float32Array): TempoEstimate {
  const minLag = Math.floor(bpmToLag(MAX_BPM));
  const maxLag = Math.ceil(bpmToLag(MIN_BPM));
  const correlation = autocorrelation(envelope, maxLag * 2 + 2);
  const at = (lag: number) => interpolate(correlation, lag);
  // Each period also earns half the score of twice its length, so a period
  // whose multiples line up beats one that matches only once.
  const score = (lag: number) => {
    const bpm = lagToBpm(lag);
    const octaves = Math.log2(bpm / PRIOR_CENTRE_BPM) / PRIOR_OCTAVES;
    return Math.exp(-0.5 * octaves * octaves) * (at(lag) + 0.5 * at(lag * 2));
  };
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!isPeak(correlation, lag)) continue;
    const value = score(lag);
    if (value > bestScore) {
      bestScore = value;
      best = lag;
    }
  }
  if (best < 0 || !(correlation[0] > 0)) {
    return { bpm: PRIOR_CENTRE_BPM, confidence: 0, alternative: null };
  }
  let lag = refine(correlation, best);
  // Prefer the faster octave when its period correlates nearly as well.
  const half = refine(correlation, Math.round(lag / 2));
  if (
    lagToBpm(half) <= MAX_BPM && at(half) >= FASTER_OCTAVE_RATIO * at(lag)
  ) {
    lag = half;
  }
  const bpm = lagToBpm(lag);
  const confidence = periodicity(envelope, correlation, lag);
  return { bpm, confidence, alternative: alternativeOctave(correlation, lag) };
}

/** Pearson correlation of the envelope with itself at these lags (beat, two beats). */
const CLEAR_PULSE = 0.5;
const NO_PULSE = 0.15;

/**
 * Confidence in the tempo: how strongly the onsets repeat at the beat, or at
 * two beats (a backbeat), as a correlation with the mean removed. Unlike the
 * raw autocorrelation, this is near 0 for onsets that don't repeat (noise,
 * steady tones, separation artefacts) whatever their level.
 */
function periodicity(envelope: Float32Array, correlation: Float64Array, lag: number): number {
  let mean = 0;
  for (const value of envelope) mean += value;
  mean /= envelope.length || 1;
  const variance = correlation[0] - mean * mean;
  if (!(variance > 1e-12)) return 0;
  const pearson = (at: number) => (interpolate(correlation, at) - mean * mean) / variance;
  const best = Math.max(pearson(lag), lag * 2 < correlation.length - 1 ? pearson(lag * 2) : 0);
  return Math.max(0, Math.min(1, (best - NO_PULSE) / (CLEAR_PULSE - NO_PULSE)));
}

/** Half or double tempo, whichever correlates better, if within range. */
function alternativeOctave(correlation: Float64Array, lag: number): number | null {
  const candidates = [lag * 2, lag / 2]
    .filter((candidate) => {
      const bpm = lagToBpm(candidate);
      return bpm >= MIN_BPM / 1.01 && bpm <= MAX_BPM * 1.01 &&
        candidate + 1 < correlation.length;
    })
    .map((candidate) => refine(correlation, Math.round(candidate)));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => interpolate(correlation, b) - interpolate(correlation, a));
  return lagToBpm(candidates[0]);
}

function isPeak(values: Float64Array, index: number): boolean {
  return values[index] >= values[index - 1] && values[index] >= values[index + 1];
}

/** Moves to the nearest local maximum, then interpolates it (parabola). */
function refine(values: Float64Array, index: number): number {
  let i = Math.max(1, Math.min(values.length - 2, index));
  for (let step = 0; step < 4; step++) {
    if (i + 1 < values.length - 1 && values[i + 1] > values[i]) i++;
    else if (i - 1 > 0 && values[i - 1] > values[i]) i--;
    else break;
  }
  const a = values[i - 1];
  const b = values[i];
  const c = values[i + 1];
  const curvature = a - 2 * b + c;
  if (curvature >= 0) return i;
  return i + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature));
}

/** Linear interpolation between integer lags. */
function interpolate(values: Float64Array, position: number): number {
  const lower = Math.floor(position);
  if (lower < 0) return values[0];
  if (lower + 1 >= values.length) return values[values.length - 1];
  const fraction = position - lower;
  return values[lower] * (1 - fraction) + values[lower + 1] * fraction;
}
