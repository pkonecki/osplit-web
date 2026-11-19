/**
 * Demucs v4 (htdemucs_6s) around the ONNX graph: whole-track normalization,
 * 7.8 s segments with 25% overlap, the STFT and inverse STFT, per-segment
 * normalization and weighted overlap-add. It mirrors demucs.separate with
 * apply_model(split=True, overlap=0.25, shifts=0); scripts/export-htdemucs.py
 * holds the NumPy reference this is tested against
 * (src/__fixtures__/demucs/stft.json).
 *
 * The graph takes and returns normalized values (see the export script): the
 * normalization divides by millions of elements, which overflows FP16.
 */
import { CHANNELS, fftInPlace } from "./audio-core";
import type { Stem } from "./types";

export const DEMUCS_SEGMENT = 343_980;
export const DEMUCS_NFFT = 4096;
export const DEMUCS_HOP = 1024;
/** STFT frames per segment, ceil(SEGMENT / HOP). */
export const DEMUCS_FRAMES = Math.ceil(DEMUCS_SEGMENT / DEMUCS_HOP);
/** Frequency bins kept: the Nyquist bin is dropped. */
export const DEMUCS_BINS = DEMUCS_NFFT / 2;
/** The graph's output order. */
export const DEMUCS_SOURCES: readonly Stem[] = [
  "drums",
  "bass",
  "other",
  "vocals",
  "guitar",
  "piano",
];
const SOURCES = DEMUCS_SOURCES.length;
const STRIDE = Math.floor(0.75 * DEMUCS_SEGMENT);
/** Spectrogram channels: L.re L.im R.re R.im. */
const SPEC_CHANNELS = 2 * CHANNELS;
const SPEC_SIZE = SPEC_CHANNELS * DEMUCS_BINS * DEMUCS_FRAMES;
const WAVE_SIZE = CHANNELS * DEMUCS_SEGMENT;
/** HTDemucs._spec pads by 3/2 hop so frames line up with the waveform. */
const SPEC_PAD = (DEMUCS_HOP / 2) * 3;
/** torch.stft's center=True padding. */
const CENTER_PAD = DEMUCS_NFFT / 2;

/** Periodic Hann window, as torch.hann_window. */
const WINDOW = Float32Array.from(
  { length: DEMUCS_NFFT },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / DEMUCS_NFFT),
);
/** Squared Hann windows at a quarter-window hop sum to 3/2. */
const WINDOW_SQUARE_SUM = 1.5;
const SQRT_NFFT = Math.sqrt(DEMUCS_NFFT);

/** numpy/torch "reflect" padding index: mirrors without repeating the edge. */
function reflect(index: number, length: number): number {
  if (index < 0) return -index;
  if (index >= length) return 2 * (length - 1) - index;
  return index;
}

/**
 * HTDemucs._spec of one segment (planar: left then right, SEGMENT samples
 * each) into `out`, laid out [channel·2 + re/im][bin][frame].
 */
export function demucsSpectrogram(
  segment: Float32Array,
  out: Float32Array = new Float32Array(SPEC_SIZE),
): Float32Array {
  const padRight = SPEC_PAD + DEMUCS_FRAMES * DEMUCS_HOP - DEMUCS_SEGMENT;
  const length1 = DEMUCS_SEGMENT + SPEC_PAD + padRight;
  const length2 = length1 + 2 * CENTER_PAD;
  // Both reflect paddings, per channel.
  const padded = [new Float32Array(length2), new Float32Array(length2)];
  for (let channel = 0; channel < CHANNELS; channel++) {
    const source = segment.subarray(
      channel * DEMUCS_SEGMENT,
      (channel + 1) * DEMUCS_SEGMENT,
    );
    const target = padded[channel];
    for (let k = 0; k < length2; k++) {
      const q = reflect(k - CENTER_PAD, length1);
      target[k] = source[reflect(q - SPEC_PAD, DEMUCS_SEGMENT)];
    }
  }
  // Two real frames in one complex FFT: left as real, right as imaginary.
  const real = new Float32Array(DEMUCS_NFFT);
  const imaginary = new Float32Array(DEMUCS_NFFT);
  const scale = 1 / SQRT_NFFT; // normalized=True
  const plane = DEMUCS_BINS * DEMUCS_FRAMES;
  for (let frame = 0; frame < DEMUCS_FRAMES; frame++) {
    // _spec drops the first two of the frames+4 STFT frames.
    const start = (frame + 2) * DEMUCS_HOP;
    for (let i = 0; i < DEMUCS_NFFT; i++) {
      real[i] = padded[0][start + i] * WINDOW[i];
      imaginary[i] = padded[1][start + i] * WINDOW[i];
    }
    fftInPlace(real, imaginary, false);
    for (let bin = 0; bin < DEMUCS_BINS; bin++) {
      const mirror = bin === 0 ? 0 : DEMUCS_NFFT - bin;
      const zr = real[bin];
      const zi = imaginary[bin];
      const mr = real[mirror];
      const mi = imaginary[mirror];
      const cell = bin * DEMUCS_FRAMES + frame;
      // Left = (Z[k] + conj(Z[N−k])) / 2, right = (Z[k] − conj(Z[N−k])) / 2i.
      out[cell] = ((zr + mr) / 2) * scale;
      out[plane + cell] = ((zi - mi) / 2) * scale;
      out[2 * plane + cell] = ((zi + mi) / 2) * scale;
      out[3 * plane + cell] = ((mr - zr) / 2) * scale;
    }
  }
  return out;
}

/**
 * HTDemucs._ispec of one stem's spectrogram (layout as demucsSpectrogram's
 * output) into planar stereo `out`, SEGMENT samples per channel.
 */
export function demucsInverse(
  spec: Float32Array,
  out: Float32Array = new Float32Array(WAVE_SIZE),
  real: Float32Array = new Float32Array(DEMUCS_NFFT),
  imaginary: Float32Array = new Float32Array(DEMUCS_NFFT),
): Float32Array {
  out.fill(0);
  const plane = DEMUCS_BINS * DEMUCS_FRAMES;
  const gain = SQRT_NFFT / WINDOW_SQUARE_SUM;
  for (let frame = 0; frame < DEMUCS_FRAMES; frame++) {
    // Both channels in one inverse FFT: Z = L + iR, each Hermitian. The
    // inverse real FFT ignores the imaginary part of the DC bin; so must we.
    // The Nyquist bin was dropped, so it is zero.
    for (let bin = 0; bin < DEMUCS_BINS; bin++) {
      const cell = bin * DEMUCS_FRAMES + frame;
      const lr = spec[cell];
      const li = bin === 0 ? 0 : spec[plane + cell];
      const rr = spec[2 * plane + cell];
      const ri = bin === 0 ? 0 : spec[3 * plane + cell];
      real[bin] = lr - ri;
      imaginary[bin] = li + rr;
      if (bin > 0) {
        // Z[N−k] = conj(L[k]) + i·conj(R[k]).
        real[DEMUCS_NFFT - bin] = lr + ri;
        imaginary[DEMUCS_NFFT - bin] = rr - li;
      }
    }
    real[DEMUCS_BINS] = 0;
    imaginary[DEMUCS_BINS] = 0;
    fftInPlace(real, imaginary, true);
    // _ispec pads two empty frames on each side; with torch.istft's center
    // padding and _ispec's trim, frame t starts at t·HOP − 3/2·HOP.
    const start = frame * DEMUCS_HOP - SPEC_PAD;
    const from = Math.max(0, -start);
    const to = Math.min(DEMUCS_NFFT, DEMUCS_SEGMENT - start);
    for (let i = from; i < to; i++) {
      const w = WINDOW[i] * gain;
      out[start + i] += real[i] * w;
      out[DEMUCS_SEGMENT + start + i] += imaginary[i] * w;
    }
  }
  return out;
}

/** Mean and standard deviation (Bessel's correction), accumulated in float64. */
export function meanStd(values: Float32Array): { mean: number; std: number } {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;
  let squares = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - mean;
    squares += d * d;
  }
  return { mean, std: Math.sqrt(squares / (values.length - 1)) };
}

function normalizeInPlace(values: Float32Array): { mean: number; std: number } {
  const stats = meanStd(values);
  const divisor = 1e-5 + stats.std;
  for (let i = 0; i < values.length; i++) {
    values[i] = (values[i] - stats.mean) / divisor;
  }
  return stats;
}

/** Runs the graph on normalized inputs; returns its normalized outputs. */
export type DemucsRun = (
  mix: Float32Array,
  spec: Float32Array,
) => Promise<{ wave: Float32Array; specs: Float32Array }>;

export interface DemucsOptions {
  /**
   * Receives each stem's samples once final, as interleaved stereo floats, in
   * order. The array is reused, so consume it right away. `source` indexes
   * DEMUCS_SOURCES.
   */
  onSamples(source: number, interleaved: Float32Array): void;
  /** Called after each segment. */
  onSegment?(done: number, total: number): void | Promise<void>;
  /** Throws to stop between steps. */
  checkCancelled?(): void;
}

export function demucsSegmentCount(frameCount: number): number {
  return Math.ceil(frameCount / STRIDE);
}

/** The overlap weight: a triangle peaking mid-segment, max 1. */
function makeWeight(): Float32Array {
  const half = Math.floor(DEMUCS_SEGMENT / 2);
  const weight = new Float32Array(DEMUCS_SEGMENT);
  for (let i = 0; i < DEMUCS_SEGMENT; i++) {
    weight[i] = (i < half ? i + 1 : DEMUCS_SEGMENT - i) / half;
  }
  return weight;
}

/**
 * Separates interleaved stereo 44.1 kHz audio into DEMUCS_SOURCES stems,
 * streaming each stem's final samples to `onSamples`.
 */
export async function separateDemucs(
  interleaved: Float32Array,
  run: DemucsRun,
  options: DemucsOptions,
): Promise<void> {
  const n = interleaved.length / CHANNELS;
  if (!Number.isInteger(n) || n === 0) {
    throw new Error("The decoded source has no valid stereo samples.");
  }
  // demucs.separate normalizes the track by its mono mix.
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mono[i] = (interleaved[2 * i] + interleaved[2 * i + 1]) / 2;
  }
  const track = meanStd(mono);
  if (!(track.std > 0)) track.std = 1; // silence: avoid dividing by zero
  const total = demucsSegmentCount(n);
  const weight = makeWeight();

  // Weighted sums for the window [offset, offset + SEGMENT), shifted by one
  // stride after each segment.
  const sums = new Float32Array(SOURCES * WAVE_SIZE);
  const weightSum = new Float32Array(DEMUCS_SEGMENT);
  const mix = new Float32Array(WAVE_SIZE);
  const spec = new Float32Array(SPEC_SIZE);
  const stem = new Float32Array(WAVE_SIZE);
  const real = new Float32Array(DEMUCS_NFFT);
  const imaginary = new Float32Array(DEMUCS_NFFT);
  const emitted = new Float32Array(STRIDE * CHANNELS);

  for (let index = 0; index < total; index++) {
    options.checkCancelled?.();
    const offset = index * STRIDE;
    const length = Math.min(n - offset, DEMUCS_SEGMENT);
    // A short last segment is centred in zero padding (TensorChunk.padded).
    const start = offset - Math.floor((DEMUCS_SEGMENT - length) / 2);
    for (let channel = 0; channel < CHANNELS; channel++) {
      for (let j = 0; j < DEMUCS_SEGMENT; j++) {
        const i = start + j;
        mix[channel * DEMUCS_SEGMENT + j] = i >= 0 && i < n
          ? (interleaved[2 * i + channel] - track.mean) / track.std
          : 0;
      }
    }
    demucsSpectrogram(mix, spec);
    const waveStats = normalizeInPlace(mix);
    const specStats = normalizeInPlace(spec);
    options.checkCancelled?.();
    const { wave, specs } = await run(mix, spec);
    if (wave.length !== SOURCES * WAVE_SIZE || specs.length !== SOURCES * SPEC_SIZE) {
      throw new Error("Unexpected output size from the Demucs model.");
    }
    options.checkCancelled?.();

    // The segment's part kept after center trimming starts here.
    const trim = Math.floor((DEMUCS_SEGMENT - length) / 2);
    for (let source = 0; source < SOURCES; source++) {
      const stemSpec = specs.subarray(source * SPEC_SIZE, (source + 1) * SPEC_SIZE);
      for (let i = 0; i < SPEC_SIZE; i++) {
        stemSpec[i] = stemSpec[i] * specStats.std + specStats.mean;
      }
      demucsInverse(stemSpec, stem, real, imaginary);
      const stemWave = wave.subarray(source * WAVE_SIZE, (source + 1) * WAVE_SIZE);
      const target = sums.subarray(source * WAVE_SIZE, (source + 1) * WAVE_SIZE);
      for (let channel = 0; channel < CHANNELS; channel++) {
        const base = channel * DEMUCS_SEGMENT;
        for (let j = 0; j < length; j++) {
          const value = stemWave[base + trim + j] * waveStats.std + waveStats.mean +
            stem[base + trim + j];
          target[base + j] += weight[j] * value;
        }
      }
    }
    for (let j = 0; j < length; j++) weightSum[j] += weight[j];

    // Samples before the next segment's start are final.
    const last = index === total - 1;
    const final = last ? length : Math.min(STRIDE, length);
    for (let source = 0; source < SOURCES; source++) {
      const target = sums.subarray(source * WAVE_SIZE, (source + 1) * WAVE_SIZE);
      for (let j = 0; j < final; j++) {
        const scale = track.std / weightSum[j];
        emitted[2 * j] = target[j] * scale + track.mean;
        emitted[2 * j + 1] = target[DEMUCS_SEGMENT + j] * scale + track.mean;
      }
      options.onSamples(source, emitted.subarray(0, final * CHANNELS));
      if (!last) {
        // Shift the window by one stride.
        for (let channel = 0; channel < CHANNELS; channel++) {
          const base = channel * DEMUCS_SEGMENT;
          target.copyWithin(base, base + STRIDE, base + DEMUCS_SEGMENT);
          target.fill(0, base + DEMUCS_SEGMENT - STRIDE, base + DEMUCS_SEGMENT);
        }
      }
    }
    if (!last) {
      weightSum.copyWithin(0, STRIDE);
      weightSum.fill(0, DEMUCS_SEGMENT - STRIDE);
    }
    await options.onSegment?.(index + 1, total);
  }
}
