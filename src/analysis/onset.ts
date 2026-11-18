import { SAMPLE_RATE } from "../audio-core";

/**
 * Onset strength: how much new energy starts in each short frame. Rhythm
 * analysis runs on mono audio at half the stem rate, which keeps everything
 * up to 11 kHz (enough for drums) at a quarter of the work.
 */

export const ANALYSIS_RATE = SAMPLE_RATE / 2;
export const ONSET_WINDOW = 1024;
export const ONSET_HOP = 256;
/** Onset frames per second (about 86). */
export const FRAME_RATE = ANALYSIS_RATE / ONSET_HOP;
/** Bins below this frequency make up the low band (kick and bass). */
const LOW_BAND_HZ = 200;
/** Bins above this frequency make up the high band (snare and hats). */
const HIGH_BAND_HZ = 5000;
/** Length of the moving average removed from the envelope. */
const LOCAL_MEAN_SECONDS = 0.5;

/** Seconds at the centre of onset frame `frame`. */
export function frameTime(frame: number): number {
  return (frame * ONSET_HOP) / ANALYSIS_RATE;
}

/** The onset frame nearest to `seconds`. */
export function timeFrame(seconds: number): number {
  return Math.round((seconds * ANALYSIS_RATE) / ONSET_HOP);
}

/**
 * Downmixes a stereo stem at SAMPLE_RATE to mono at ANALYSIS_RATE, with a
 * low-pass filter before dropping every other sample. Adds into `into` when
 * given (to sum stems), else into a new buffer.
 */
export function downmixForAnalysis(
  left: Float32Array,
  right: Float32Array,
  into?: Float32Array,
): Float32Array {
  const output = into ?? new Float32Array(analysisLength(left, right));
  downmixRange(left, right, output, 0, output.length);
  return output;
}

/** Output length of `downmixForAnalysis` for these channels. */
export function analysisLength(left: Float32Array, right: Float32Array): number {
  return Math.floor(Math.min(left.length, right.length) / 2);
}

/**
 * `downmixForAnalysis` for output samples [from, to), adding into `output`
 * (so a long stem can be processed in slices between other work).
 */
export function downmixRange(
  left: Float32Array,
  right: Float32Array,
  output: Float32Array,
  from: number,
  to: number,
): void {
  const frames = Math.min(left.length, right.length);
  const taps = LOW_PASS;
  const half = (taps.length - 1) / 2;
  const end = Math.min(to, output.length, Math.floor(frames / 2));
  for (let i = from; i < end; i++) {
    const centre = i * 2;
    let sum = 0;
    for (let k = 0; k < taps.length; k++) {
      const index = centre + k - half;
      if (index < 0 || index >= frames) continue;
      sum += taps[k] * (left[index] + right[index]);
    }
    output[i] += sum * 0.5;
  }
}

/** Windowed-sinc low-pass at a quarter of the input rate (half-band). */
const LOW_PASS = (() => {
  const count = 31;
  const half = (count - 1) / 2;
  const taps = new Float32Array(count);
  let total = 0;
  for (let k = 0; k < count; k++) {
    const n = k - half;
    const sinc = n === 0 ? 0.5 : Math.sin(Math.PI * n * 0.5) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (count - 1));
    taps[k] = sinc * window;
    total += taps[k];
  }
  for (let k = 0; k < count; k++) taps[k] /= total;
  return taps;
})();

export interface OnsetEnvelopes {
  /** All bands, with the low and high bands weighted up. */
  full: Float32Array;
  /** Low band only (kick drum, bass notes), for downbeats. */
  low: Float32Array;
}

/**
 * Spectral flux of log-compressed magnitudes, half-wave rectified, summed
 * over bins; then the local mean is removed and the result scaled to unit
 * standard deviation. Frame `t` is centred on sample `t · ONSET_HOP`.
 */
export function onsetEnvelopes(samples: Float32Array): OnsetEnvelopes {
  const frames = Math.max(1, Math.ceil(samples.length / ONSET_HOP));
  const bins = ONSET_WINDOW / 2 + 1;
  const binHz = ANALYSIS_RATE / ONSET_WINDOW;
  const lowBins = Math.ceil(LOW_BAND_HZ / binHz);
  const highBin = Math.floor(HIGH_BAND_HZ / binHz);
  const window = hann(ONSET_WINDOW);
  const spectrum = makeMagnitudeSpectrum(ONSET_WINDOW);
  const input = new Float64Array(ONSET_WINDOW);
  const magnitudes = new Float64Array(bins);
  let previous = new Float64Array(bins);
  let current = new Float64Array(bins);
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * ONSET_HOP - ONSET_WINDOW / 2;
    for (let i = 0; i < ONSET_WINDOW; i++) {
      const index = start + i;
      input[i] = index >= 0 && index < samples.length ? samples[index] * window[i] : 0;
    }
    spectrum(input, magnitudes);
    let lowFlux = 0;
    let midFlux = 0;
    let highFlux = 0;
    for (let bin = 1; bin < bins; bin++) {
      current[bin] = Math.log1p(100 * magnitudes[bin]);
      const rise = current[bin] - previous[bin];
      if (rise <= 0 || frame === 0) continue;
      if (bin < lowBins) lowFlux += rise;
      else if (bin > highBin) highFlux += rise;
      else midFlux += rise;
    }
    // The low band has few bins; weight it so a kick counts as much as a
    // snare's broadband burst.
    full[frame] = midFlux + highFlux * 1.5 + lowFlux * 4;
    low[frame] = lowFlux;
    [previous, current] = [current, previous];
  }
  return { full: normalize(full), low: normalize(low) };
}

/** Removes the moving average, keeps the positive part, scales to unit std. */
function normalize(envelope: Float32Array): Float32Array {
  const radius = Math.max(1, Math.round((LOCAL_MEAN_SECONDS * FRAME_RATE) / 2));
  const output = new Float32Array(envelope.length);
  let sum = 0;
  let count = 0;
  // Running window [i - radius, i + radius].
  for (let i = 0; i <= Math.min(radius, envelope.length - 1); i++) {
    sum += envelope[i];
    count++;
  }
  for (let i = 0; i < envelope.length; i++) {
    output[i] = Math.max(0, envelope[i] - sum / count);
    const add = i + radius + 1;
    const remove = i - radius;
    if (add < envelope.length) {
      sum += envelope[add];
      count++;
    }
    if (remove >= 0) {
      sum -= envelope[remove];
      count--;
    }
  }
  const deviation = standardDeviation(output);
  if (deviation > 0) {
    for (let i = 0; i < output.length; i++) output[i] /= deviation;
  }
  return output;
}

export function standardDeviation(values: ArrayLike<number>): number {
  if (values.length < 2) return 0;
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i];
  mean /= values.length;
  let squares = 0;
  for (let i = 0; i < values.length; i++) squares += (values[i] - mean) ** 2;
  return Math.sqrt(squares / (values.length - 1));
}

/** Root mean square of a signal (to tell a silent stem from a playing one). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Magnitude spectrum of a real frame (bins 0…size/2), computed with a
 * complex FFT of half the size on the even and odd samples, with the bit
 * reversal and twiddle factors precomputed.
 */
export function makeMagnitudeSpectrum(
  size: number,
): (input: Float64Array, magnitudes: Float64Array) => void {
  const half = size / 2;
  const fft = makeFft(half);
  const real = new Float64Array(half);
  const imaginary = new Float64Array(half);
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / size);
    sin[k] = Math.sin((-2 * Math.PI * k) / size);
  }
  return (input, magnitudes) => {
    for (let n = 0; n < half; n++) {
      real[n] = input[2 * n];
      imaginary[n] = input[2 * n + 1];
    }
    fft(real, imaginary);
    magnitudes[0] = Math.abs(real[0] + imaginary[0]);
    magnitudes[half] = Math.abs(real[0] - imaginary[0]);
    for (let k = 1; k < half; k++) {
      const zr = real[k];
      const zi = imaginary[k];
      const cr = real[half - k];
      const ci = -imaginary[half - k];
      // Even part (Z[k] + conj Z[N/2−k]) / 2, odd part (Z[k] − conj Z[N/2−k]) / 2i.
      const evenReal = (zr + cr) / 2;
      const evenImaginary = (zi + ci) / 2;
      const oddReal = (zi - ci) / 2;
      const oddImaginary = -(zr - cr) / 2;
      const re = evenReal + cos[k] * oddReal - sin[k] * oddImaginary;
      const im = evenImaginary + cos[k] * oddImaginary + sin[k] * oddReal;
      magnitudes[k] = Math.sqrt(re * re + im * im);
    }
  };
}

/** In-place forward complex FFT of a fixed power-of-two size. */
function makeFft(size: number): (real: Float64Array, imaginary: Float64Array) => void {
  const bits = Math.log2(size);
  const reversed = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / size);
    sin[i] = Math.sin((-2 * Math.PI * i) / size);
  }
  return (real, imaginary) => {
    for (let i = 0; i < size; i++) {
      const j = reversed[i];
      if (i < j) {
        const r = real[i];
        real[i] = real[j];
        real[j] = r;
        const m = imaginary[i];
        imaginary[i] = imaginary[j];
        imaginary[j] = m;
      }
    }
    for (let block = 2; block <= size; block <<= 1) {
      const halfBlock = block >> 1;
      const stride = size / block;
      for (let start = 0; start < size; start += block) {
        for (let offset = 0; offset < halfBlock; offset++) {
          const even = start + offset;
          const odd = even + halfBlock;
          const wr = cos[offset * stride];
          const wi = sin[offset * stride];
          const oddReal = real[odd] * wr - imaginary[odd] * wi;
          const oddImaginary = real[odd] * wi + imaginary[odd] * wr;
          real[odd] = real[even] - oddReal;
          imaginary[odd] = imaginary[even] - oddImaginary;
          real[even] += oddReal;
          imaginary[even] += oddImaginary;
        }
      }
    }
  };
}

export function hann(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  }
  return window;
}
