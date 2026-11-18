import { ANALYSIS_RATE, hann, makeMagnitudeSpectrum, rms } from "./onset";

/**
 * Chroma: how much of each of the 12 pitch classes sounds in each frame,
 * from a short-time spectrum, with bins mapped to pitch classes allowing for
 * the track's tuning. Then averaged between beats (beat-synchronous), so each
 * vector describes one beat.
 */

export const CHROMA_WINDOW = 4096;
/** The bass chroma needs finer frequency resolution at low pitches. */
export const BASS_CHROMA_WINDOW = 8192;
export const CHROMA_HOP = 1024;
/** Chroma frames per second (about 21.5). */
export const CHROMA_FRAME_RATE = ANALYSIS_RATE / CHROMA_HOP;
/** Range of the harmonic chroma, and of the bass chroma. */
export const HARMONIC_RANGE: [number, number] = [55, 4000];
export const BASS_RANGE: [number, number] = [30, 250];

export interface Chromagram {
  /** frames × 12, frame-major. */
  values: Float32Array;
  frames: number;
}

/** Seconds at the centre of chroma frame `frame`. */
export function chromaFrameTime(frame: number): number {
  return (frame * CHROMA_HOP) / ANALYSIS_RATE;
}

/** The MIDI pitch (fractional) of `hz`, with the tuning offset removed. */
export function midiPitch(hz: number, tuningCents = 0): number {
  return 69 + 12 * Math.log2(hz / 440) - tuningCents / 100;
}

/**
 * Calls `each(frame, magnitudes)` for frames centred every `hop · step`
 * samples (Hann window), magnitudes scaled so a sine at the signal's RMS
 * level peaks near 1.
 */
export function forEachSpectrum(
  samples: Float32Array,
  window: number,
  each: (frame: number, magnitudes: Float64Array) => void,
  step = 1,
): void {
  const frames = Math.max(1, Math.ceil(samples.length / CHROMA_HOP));
  const taper = hann(window);
  const spectrum = makeMagnitudeSpectrum(window);
  const input = new Float64Array(window);
  const magnitudes = new Float64Array(window / 2 + 1);
  const level = rms(samples);
  const scale = level > 0 ? 4 / (window * level) : 0;
  for (let frame = 0; frame < frames; frame += step) {
    const start = frame * CHROMA_HOP - window / 2;
    for (let i = 0; i < window; i++) {
      const index = start + i;
      input[i] = index >= 0 && index < samples.length ? samples[index] * taper[i] : 0;
    }
    spectrum(input, magnitudes);
    for (let bin = 0; bin < magnitudes.length; bin++) magnitudes[bin] *= scale;
    each(frame, magnitudes);
  }
}

/**
 * Chroma of `samples` (mono, ANALYSIS_RATE) over the frequency `range`, with
 * log-compressed magnitudes. Each bin counts towards its nearest pitch class
 * with a weight falling linearly to 0 half a semitone away.
 */
export function chromagram(
  samples: Float32Array,
  options: { tuningCents?: number; window?: number; range?: [number, number] } = {},
): Chromagram {
  const window = options.window ?? CHROMA_WINDOW;
  const [minHz, maxHz] = options.range ?? HARMONIC_RANGE;
  const binHz = ANALYSIS_RATE / window;
  const bins: number[] = [];
  const classes: number[] = [];
  const weights: number[] = [];
  for (let bin = Math.ceil(minHz / binHz); bin <= Math.floor(maxHz / binHz); bin++) {
    const pitch = midiPitch(bin * binHz, options.tuningCents ?? 0);
    const nearest = Math.round(pitch);
    const weight = 1 - 2 * Math.abs(pitch - nearest);
    if (weight <= 0) continue;
    bins.push(bin);
    classes.push(((nearest % 12) + 12) % 12);
    weights.push(weight);
  }
  const frames = Math.max(1, Math.ceil(samples.length / CHROMA_HOP));
  const values = new Float32Array(frames * 12);
  forEachSpectrum(samples, window, (frame, magnitudes) => {
    const offset = frame * 12;
    for (let i = 0; i < bins.length; i++) {
      values[offset + classes[i]] += weights[i] * Math.log1p(10 * magnitudes[bins[i]]);
    }
  });
  return { values, frames };
}

export interface BeatChroma {
  /** segments × 12, each L2-normalised (zero when silent). */
  vectors: Float32Array;
  /** Loudness of each segment before normalising. */
  energy: Float32Array;
  count: number;
}

/**
 * The median chroma frame of each segment between consecutive `boundaries`
 * (seconds), L2-normalised.
 */
export function segmentChroma(chroma: Chromagram, boundaries: ArrayLike<number>): BeatChroma {
  const count = Math.max(0, boundaries.length - 1);
  const vectors = new Float32Array(count * 12);
  const energy = new Float32Array(count);
  const column: number[] = [];
  for (let segment = 0; segment < count; segment++) {
    let from = Math.ceil(boundaries[segment] * CHROMA_FRAME_RATE);
    let to = Math.ceil(boundaries[segment + 1] * CHROMA_FRAME_RATE);
    from = Math.max(0, Math.min(chroma.frames - 1, from));
    to = Math.max(from + 1, Math.min(chroma.frames, to));
    const offset = segment * 12;
    let squares = 0;
    for (let pc = 0; pc < 12; pc++) {
      column.length = 0;
      for (let frame = from; frame < to; frame++) column.push(chroma.values[frame * 12 + pc]);
      const value = median(column);
      vectors[offset + pc] = value;
      squares += value * value;
      energy[segment] += value;
    }
    const norm = Math.sqrt(squares);
    if (norm > 0) for (let pc = 0; pc < 12; pc++) vectors[offset + pc] /= norm;
  }
  return { vectors, energy, count };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Segments: between beats (with the start and end of the track), else fixed 0.5 s frames. */
export const FALLBACK_SEGMENT_SECONDS = 0.5;
/** A boundary closer than this to the previous one is dropped. */
const MIN_SEGMENT_SECONDS = 0.1;

export function segmentBoundaries(beats: ArrayLike<number>, duration: number): number[] {
  const times: number[] = [0];
  const push = (time: number) => {
    if (time - times[times.length - 1] >= MIN_SEGMENT_SECONDS && duration - time >= MIN_SEGMENT_SECONDS) {
      times.push(time);
    }
  };
  if (beats.length >= 4) {
    for (let i = 0; i < beats.length; i++) push(beats[i]);
  } else {
    for (let time = FALLBACK_SEGMENT_SECONDS; time < duration; time += FALLBACK_SEGMENT_SECONDS) {
      push(time);
    }
  }
  times.push(Math.max(duration, times[times.length - 1] + MIN_SEGMENT_SECONDS));
  return times;
}
