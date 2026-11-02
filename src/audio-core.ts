export const SAMPLE_RATE = 44_100;
export const FRAME_LENGTH = 4096;
export const HOP_LENGTH = 1024;
export const SEGMENT_FRAMES = 512;
export const FREQUENCY_BINS = 1024;
export const CHANNELS = 2;
export const SAMPLES_PER_SEGMENT = SEGMENT_FRAMES * FREQUENCY_BINS;
export const OVERLAP_BUFFER_SIZE = FRAME_LENGTH * 2;
export const WAV_HEADER_BYTES = 44;
const WINDOW_COMPENSATION = 2 / 3;

export function resampleStereo(
  left: Float32Array,
  right: Float32Array,
  sourceRate: number,
): Float32Array {
  if (sourceRate <= 0 || left.length === 0 || right.length === 0) {
    throw new Error("The audio source has no decodable samples.");
  }
  const sourceFrames = Math.min(left.length, right.length);
  const outputFrames = Math.max(1, Math.floor(sourceFrames * SAMPLE_RATE / sourceRate));
  const stereo = new Float32Array(outputFrames * CHANNELS);
  for (let frame = 0; frame < outputFrames; frame++) {
    const position = frame * sourceRate / SAMPLE_RATE;
    const lower = Math.min(Math.floor(position), sourceFrames - 1);
    const upper = Math.min(lower + 1, sourceFrames - 1);
    const fraction = position - lower;
    stereo[frame * 2] = left[lower] + (left[upper] - left[lower]) * fraction;
    stereo[frame * 2 + 1] = right[lower] + (right[upper] - right[lower]) * fraction;
  }
  return stereo;
}

export function makeHannWindow(): Float32Array {
  const window = new Float32Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME_LENGTH);
  }
  return window;
}

export function makeSynthesisWindow(): Float32Array {
  const window = makeHannWindow();
  for (let i = 0; i < window.length; i++) window[i] *= WINDOW_COMPENSATION;
  return window;
}

export function fftInPlace(real: Float32Array, imaginary: Float32Array, inverse: boolean): void {
  const length = real.length;
  if (length !== imaginary.length || (length & (length - 1)) !== 0) {
    throw new Error("FFT buffers must have the same power-of-two length.");
  }
  let j = 0;
  for (let i = 1; i < length; i++) {
    let bit = length >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }

  for (let blockLength = 2; blockLength <= length; blockLength <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / blockLength;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    const halfLength = blockLength >> 1;
    for (let blockStart = 0; blockStart < length; blockStart += blockLength) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < halfLength; offset++) {
        const even = blockStart + offset;
        const odd = even + halfLength;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < length; i++) {
      real[i] /= length;
      imaginary[i] /= length;
    }
  }
}

export function encodeWav(samples: Float32Array, frameCount: number): Blob {
  if (samples.length !== frameCount * CHANNELS) {
    throw new Error("Stereo sample count does not match the frame count.");
  }
  const bytes = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes);
  writeText(view, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * CHANNELS * 2, true);
  view.setUint16(32, CHANNELS * 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      WAV_HEADER_BYTES + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export function mixWavBlobs(blobs: Blob[], gains: number[]): Promise<Blob> {
  if (blobs.length === 0 || blobs.length !== gains.length) {
    return Promise.reject(new Error("No usable stems are selected for the mix."));
  }
  return Promise.all(blobs.map((blob) => blob.arrayBuffer())).then((buffers) => {
    const views = buffers.map((buffer) => new DataView(buffer));
    const frames = views.map((view) => readWavFrames(view));
    if (frames.some((count) => count !== frames[0])) {
      throw new Error("The project stems have different lengths.");
    }
    const frameCount = frames[0];
    const output = new Float32Array(frameCount * CHANNELS);
    let peak = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      for (let channel = 0; channel < CHANNELS; channel++) {
        let value = 0;
        views.forEach((view, stemIndex) => {
          value += view.getInt16(WAV_HEADER_BYTES + (frame * CHANNELS + channel) * 2, true) /
            32768 * gains[stemIndex];
        });
        output[frame * CHANNELS + channel] = value;
        peak = Math.max(peak, Math.abs(value));
      }
    }
    if (peak > 1) {
      for (let i = 0; i < output.length; i++) output[i] /= peak;
    }
    return encodeWav(output, frameCount);
  });
}

export function readWavFrames(view: DataView): number {
  if (view.byteLength < WAV_HEADER_BYTES || readText(view, 0, 4) !== "RIFF" ||
      readText(view, 8, 4) !== "WAVE") {
    throw new Error("A project stem is not a valid WAV file.");
  }
  if (view.getUint16(22, true) !== CHANNELS || view.getUint32(24, true) !== SAMPLE_RATE ||
      view.getUint16(34, true) !== 16 || readText(view, 36, 4) !== "data") {
    throw new Error("Project stems must be stereo 44.1 kHz 16-bit PCM WAV files.");
  }
  const dataBytes = view.getUint32(40, true);
  if (dataBytes % (CHANNELS * 2) !== 0 || view.byteLength < WAV_HEADER_BYTES + dataBytes) {
    throw new Error("A project stem is incomplete.");
  }
  return dataBytes / (CHANNELS * 2);
}

function writeText(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

function readText(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
}
