import {
  CHANNELS,
  fftInPlace,
  FRAME_LENGTH,
  FREQUENCY_BINS,
  HOP_LENGTH,
  makeHannWindow,
  makeSynthesisWindow,
  OVERLAP_BUFFER_SIZE,
  SAMPLES_PER_SEGMENT,
  SEGMENT_FRAMES,
} from "./audio-core";

/**
 * Short-time Fourier transform around the separation models.
 *
 * The audio is cut into frames of FRAME_LENGTH samples every HOP_LENGTH
 * samples (Hann window), and frames are grouped into segments of
 * SEGMENT_FRAMES, the models' input size. For each segment the models get a
 * magnitude spectrogram [channel][time][frequency] and return one logit per
 * stem and bin; a softmax across stems turns those into masks that sum to 1,
 * so the stems add back up to the input. Masked spectra are turned back into
 * audio with an inverse FFT and overlap-add.
 */

/**
 * The models' logits are scaled by this factor before the softmax across
 * stems, sharpening the masks. It matches how the models were trained and
 * must not change, or every separation would differ.
 */
export const LOGIT_SCALE = 2;

export interface StftPlan {
  /** Stereo frames in the input. */
  frameCount: number;
  /** Analysis frames needed to cover the input plus one frame of padding. */
  analysisFrameCount: number;
  /** Model calls needed (segments of SEGMENT_FRAMES analysis frames). */
  segmentCount: number;
}

export function planStft(frameCount: number): StftPlan {
  const analysisFrameCount = Math.ceil((frameCount + FRAME_LENGTH) / HOP_LENGTH);
  return {
    frameCount,
    analysisFrameCount,
    segmentCount: Math.ceil(analysisFrameCount / SEGMENT_FRAMES),
  };
}

/** Number of analysis frames in segment `segment` (the last one is shorter). */
export function segmentFrames(plan: StftPlan, segment: number): number {
  return Math.min(
    SEGMENT_FRAMES,
    plan.analysisFrameCount - segment * SEGMENT_FRAMES,
  );
}

/** Index of a [channel][time][frequency] bin in a segment's arrays. */
function featureIndex(channel: number, time: number, frequency: number): number {
  return (channel * SEGMENT_FRAMES + time) * FREQUENCY_BINS + frequency;
}

/** Turns segments of interleaved stereo audio into model input. */
export class SegmentAnalyzer {
  private readonly window = makeHannWindow();
  private readonly real = new Float32Array(FRAME_LENGTH);
  private readonly imaginary = new Float32Array(FRAME_LENGTH);
  /** Model input: magnitudes, CHANNELS × SEGMENT_FRAMES × FREQUENCY_BINS. */
  readonly spectrogram = new Float32Array(CHANNELS * SAMPLES_PER_SEGMENT);
  /** Complex spectra (re, im) of the same bins, used for synthesis. */
  readonly spectra = new Float32Array(CHANNELS * SAMPLES_PER_SEGMENT * 2);

  private readonly samples: Float32Array;
  private readonly plan: StftPlan;

  constructor(samples: Float32Array, plan: StftPlan) {
    this.samples = samples;
    this.plan = plan;
  }

  analyze(segment: number): void {
    const { real, imaginary, window, samples, spectrogram, spectra } = this;
    const { frameCount } = this.plan;
    const firstFrame = segment * SEGMENT_FRAMES;
    const validFrames = segmentFrames(this.plan, segment);
    spectrogram.fill(0);
    spectra.fill(0);

    for (let channel = 0; channel < CHANNELS; channel++) {
      for (let time = 0; time < validFrames; time++) {
        const globalFrame = firstFrame + time;
        const sourceStart = globalFrame * HOP_LENGTH - FRAME_LENGTH;
        for (let i = 0; i < FRAME_LENGTH; i++) {
          const sourceIndex = sourceStart + i;
          real[i] = sourceIndex >= 0 && sourceIndex < frameCount
            ? samples[sourceIndex * CHANNELS + channel] * window[i]
            : 0;
          imaginary[i] = 0;
        }
        fftInPlace(real, imaginary, false);
        for (let frequency = 0; frequency < FREQUENCY_BINS; frequency++) {
          const feature = featureIndex(channel, time, frequency);
          const complex = feature * 2;
          const re = real[frequency];
          const im = imaginary[frequency];
          spectrogram[feature] = Math.hypot(re, im);
          spectra[complex] = re;
          spectra[complex + 1] = im;
        }
      }
    }
  }
}

/**
 * Converts per-stem logits into masks in place: for every bin, a softmax
 * across stems of the logits scaled by LOGIT_SCALE. `logits` holds
 * `sourceCount` blocks of CHANNELS × SAMPLES_PER_SEGMENT values.
 */
export function logitsToMasks(
  logits: Float32Array,
  sourceCount: number,
  validFrames: number,
): void {
  const stride = CHANNELS * SAMPLES_PER_SEGMENT;
  for (let channel = 0; channel < CHANNELS; channel++) {
    for (let time = 0; time < validFrames; time++) {
      for (let frequency = 0; frequency < FREQUENCY_BINS; frequency++) {
        const feature = featureIndex(channel, time, frequency);
        let maxLogit = -Infinity;
        for (let source = 0; source < sourceCount; source++) {
          const index = source * stride + feature;
          const scaled = logits[index] * LOGIT_SCALE;
          logits[index] = scaled;
          maxLogit = Math.max(maxLogit, scaled);
        }
        let denominator = 0;
        for (let source = 0; source < sourceCount; source++) {
          const index = source * stride + feature;
          logits[index] = Math.exp(logits[index] - maxLogit);
          denominator += logits[index];
        }
        for (let source = 0; source < sourceCount; source++) {
          logits[source * stride + feature] /= denominator;
        }
      }
    }
  }
}

/**
 * Applies masks to the analysed spectra and rebuilds one interleaved stereo
 * signal per stem by inverse FFT and overlap-add. Segments must be
 * synthesized in order; each call writes the output samples that no later
 * frame can still change.
 */
export class OverlapAddSynthesizer {
  private readonly synthesisWindow = makeSynthesisWindow();
  private readonly real = new Float32Array(FRAME_LENGTH);
  private readonly imaginary = new Float32Array(FRAME_LENGTH);
  private readonly overlap: Float32Array[];
  private readonly plan: StftPlan;
  private readonly outputs: Float32Array[];
  private nextSampleToWrite = 0;

  /** `outputs`: one interleaved stereo buffer of frameCount frames per stem. */
  constructor(plan: StftPlan, outputs: Float32Array[]) {
    this.plan = plan;
    this.outputs = outputs;
    this.overlap = Array.from(
      { length: outputs.length * CHANNELS },
      () => new Float32Array(OVERLAP_BUFFER_SIZE),
    );
  }

  synthesize(segment: number, spectra: Float32Array, masks: Float32Array): void {
    const { real, imaginary, synthesisWindow, overlap, outputs } = this;
    const sourceCount = outputs.length;
    const stride = CHANNELS * SAMPLES_PER_SEGMENT;
    const paddedFrameLimit = this.plan.frameCount + FRAME_LENGTH;
    const firstFrame = segment * SEGMENT_FRAMES;
    const validFrames = segmentFrames(this.plan, segment);

    for (let time = 0; time < validFrames; time++) {
      const startSample = (firstFrame + time) * HOP_LENGTH;
      for (let channel = 0; channel < CHANNELS; channel++) {
        for (let source = 0; source < sourceCount; source++) {
          real.fill(0);
          imaginary.fill(0);
          for (let frequency = 0; frequency < FREQUENCY_BINS; frequency++) {
            const feature = featureIndex(channel, time, frequency);
            const complex = feature * 2;
            const mask = masks[source * stride + feature];
            real[frequency] = spectra[complex] * mask;
            imaginary[frequency] = spectra[complex + 1] * mask;
            if (frequency > 0) {
              real[FRAME_LENGTH - frequency] = real[frequency];
              imaginary[FRAME_LENGTH - frequency] = -imaginary[frequency];
            }
          }
          fftInPlace(real, imaginary, true);
          const buffer = overlap[source * CHANNELS + channel];
          for (let i = 0; i < FRAME_LENGTH; i++) {
            const ring = (startSample + i) % OVERLAP_BUFFER_SIZE;
            buffer[ring] += real[i] * synthesisWindow[i];
          }
        }
      }

      // Samples before the next frame's start are final: copy them out.
      const safeEnd = Math.min(startSample + HOP_LENGTH, paddedFrameLimit);
      const writeStart = Math.max(this.nextSampleToWrite, FRAME_LENGTH);
      for (let sample = writeStart; sample < safeEnd; sample++) {
        const outputFrame = sample - FRAME_LENGTH;
        const ring = sample % OVERLAP_BUFFER_SIZE;
        for (let source = 0; source < sourceCount; source++) {
          const out = outputs[source];
          out[outputFrame * CHANNELS] = overlap[source * CHANNELS][ring];
          out[outputFrame * CHANNELS + 1] =
            overlap[source * CHANNELS + 1][ring];
        }
        for (const buffer of overlap) buffer[ring] = 0;
      }
      this.nextSampleToWrite = startSample + HOP_LENGTH;
    }
  }
}
