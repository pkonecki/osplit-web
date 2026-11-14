import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  SAMPLE_RATE,
  SAMPLES_PER_SEGMENT,
  toPcm16,
} from "./audio-core";
import {
  LOGIT_SCALE,
  logitsToMasks,
  OverlapAddSynthesizer,
  type PcmStream,
  planStft,
  type StemOutput,
  SegmentAnalyzer,
  segmentFrames,
} from "./stft";

const STRIDE = CHANNELS * SAMPLES_PER_SEGMENT;

/**
 * The models see only the lowest FREQUENCY_BINS (1024 of 2049) bins of each
 * 4096-sample frame, i.e. up to about 11 kHz, and the rest is not
 * resynthesized. Test signals stay below that.
 */
const CUTOFF_HZ = (1024 * SAMPLE_RATE) / 4096;

/** Deterministic stereo test signal of tones below the cutoff. */
function testSignal(frameCount: number, tonesHz = [220, 3300, 9000]): Float32Array {
  const samples = new Float32Array(frameCount * CHANNELS);
  for (let frame = 0; frame < frameCount; frame++) {
    const t = frame / SAMPLE_RATE;
    let left = 0;
    let right = 0;
    tonesHz.forEach((hz, index) => {
      left += 0.25 * Math.sin(2 * Math.PI * hz * t + index);
      right += 0.2 * Math.sin(2 * Math.PI * hz * 1.1 * t + index);
    });
    samples[frame * 2] = left;
    samples[frame * 2 + 1] = right;
  }
  return samples;
}

/** Runs analysis and synthesis with masks chosen per segment. */
function roundTrip(
  samples: Float32Array,
  sourceCount: number,
  masksFor: (masks: Float32Array, validFrames: number) => void,
): Float32Array[] {
  const plan = planStft(samples.length / CHANNELS);
  const outputs = Array.from(
    { length: sourceCount },
    () => new Float32Array(samples.length),
  );
  const analyzer = new SegmentAnalyzer(samples, plan);
  const synthesizer = new OverlapAddSynthesizer(plan, outputs);
  const masks = new Float32Array(sourceCount * STRIDE);
  for (let segment = 0; segment < plan.segmentCount; segment++) {
    analyzer.analyze(segment);
    masksFor(masks, segmentFrames(plan, segment));
    synthesizer.synthesize(segment, analyzer.spectra, masks);
  }
  return outputs;
}

/**
 * Largest difference, ignoring two frames at each end: the test signals start
 * and stop abruptly, that click has content above the cutoff, and it reaches
 * every output sample of the frames overlapping it.
 */
function maxError(a: Float32Array, b: Float32Array): number {
  const margin = 2 * 4096 * CHANNELS;
  let max = 0;
  for (let i = margin; i < a.length - margin; i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

describe("STFT analysis and synthesis", () => {
  // A segment is 512 frames of 1024 samples (about 11.9 s): 13 s spans two
  // segments, so the hand-over between segments is covered.
  const samples = testSignal(SAMPLE_RATE * 13);

  it("plans enough segments to cover the input", () => {
    const plan = planStft(samples.length / CHANNELS);
    expect(plan.segmentCount).toBe(2);
    expect(segmentFrames(plan, 0)).toBe(512);
    expect(segmentFrames(plan, 1)).toBe(plan.analysisFrameCount - 512);
  });

  it("reconstructs the input when one stem gets the whole mask", () => {
    const [kept, dropped] = roundTrip(samples, 2, (masks) => {
      masks.fill(0);
      masks.fill(1, 0, STRIDE);
    });
    expect(maxError(kept, samples)).toBeLessThan(1e-4);
    expect(dropped.every((value) => value === 0)).toBe(true);
  });

  it("splits into stems that add back up to the input", () => {
    const stems = roundTrip(samples, 5, (masks, validFrames) => {
      // Uneven, frequency-dependent logits, turned into masks by the softmax.
      for (let i = 0; i < masks.length; i++) masks[i] = Math.sin(i * 0.37);
      logitsToMasks(masks, 5, validFrames);
    });
    const sum = new Float32Array(samples.length);
    for (const stem of stems) {
      for (let i = 0; i < sum.length; i++) sum[i] += stem[i];
    }
    expect(maxError(sum, samples)).toBeLessThan(1e-4);
    // The split is real: no single stem carries the whole signal.
    for (const stem of stems) expect(maxError(stem, samples)).toBeGreaterThan(0.01);
  });

  it("drops content above the models' frequency range", () => {
    expect(CUTOFF_HZ).toBeCloseTo(11025, 0);
    const high = testSignal(Math.round(SAMPLE_RATE * 0.5), [15000]);
    const [kept] = roundTrip(high, 1, (masks) => masks.fill(1));
    const peak = high.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    expect(maxError(kept, new Float32Array(kept.length))).toBeLessThan(peak * 0.01);
  });
});

describe("16-bit output", () => {
  it("writes exactly the PCM that encoding the float output would", () => {
    const samples = testSignal(SAMPLE_RATE * 13);
    const plan = planStft(samples.length / CHANNELS);
    const run = (outputs: StemOutput[]) => {
      const analyzer = new SegmentAnalyzer(samples, plan);
      const synthesizer = new OverlapAddSynthesizer(plan, outputs);
      const masks = new Float32Array(3 * STRIDE);
      for (let segment = 0; segment < plan.segmentCount; segment++) {
        analyzer.analyze(segment);
        for (let i = 0; i < masks.length; i++) masks[i] = Math.cos(i * 0.11);
        logitsToMasks(masks, 3, segmentFrames(plan, segment));
        synthesizer.synthesize(segment, analyzer.spectra, masks);
      }
      return outputs;
    };
    const floats = run([0, 1, 2].map(() => new Float32Array(samples.length)));
    const pcm = run([0, 1, 2].map(() => new Int16Array(samples.length)));
    let mismatches = 0;
    for (let stem = 0; stem < 3; stem++) {
      for (let i = 0; i < samples.length; i++) {
        if (pcm[stem][i] !== toPcm16(floats[stem][i])) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  }, 60_000);

  it("streams the same samples as full-length 16-bit outputs", () => {
    const samples = testSignal(SAMPLE_RATE * 13);
    const plan = planStft(samples.length / CHANNELS);
    const run = (outputs: StemOutput[] | PcmStream) => {
      const analyzer = new SegmentAnalyzer(samples, plan);
      const synthesizer = new OverlapAddSynthesizer(plan, outputs);
      const masks = new Float32Array(2 * STRIDE);
      for (let segment = 0; segment < plan.segmentCount; segment++) {
        analyzer.analyze(segment);
        for (let i = 0; i < masks.length; i++) masks[i] = Math.sin(i * 0.07);
        logitsToMasks(masks, 2, segmentFrames(plan, segment));
        synthesizer.synthesize(segment, analyzer.spectra, masks);
      }
    };
    const full = [new Int16Array(samples.length), new Int16Array(samples.length)];
    run(full);
    const streamed = [new Int16Array(samples.length), new Int16Array(samples.length)];
    const written = [0, 0];
    let calls = 0;
    run({
      sourceCount: 2,
      onSamples(source, pcm) {
        streamed[source].set(pcm, written[source]);
        written[source] += pcm.length;
        calls++;
      },
    });
    expect(written).toEqual([samples.length, samples.length]);
    expect(calls).toBe(2 * plan.segmentCount);
    let mismatches = 0;
    for (let stem = 0; stem < 2; stem++) {
      for (let i = 0; i < samples.length; i++) {
        if (streamed[stem][i] !== full[stem][i]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  }, 60_000);

  it("rejects a mix of float and 16-bit outputs", () => {
    const plan = planStft(1000);
    expect(() =>
      new OverlapAddSynthesizer(plan, [new Float32Array(2000), new Int16Array(2000)])
    ).toThrow(/same sample type/);
  });
});

describe("logitsToMasks", () => {
  it("produces masks that sum to 1 and favour the larger logit", () => {
    const logits = new Float32Array(3 * STRIDE);
    logits[0] = 1;
    logits[STRIDE] = 0;
    logits[2 * STRIDE] = -1;
    logitsToMasks(logits, 3, 1);
    const masks = [logits[0], logits[STRIDE], logits[2 * STRIDE]];
    expect(masks[0] + masks[1] + masks[2]).toBeCloseTo(1, 6);
    expect(masks[0]).toBeGreaterThan(masks[1]);
    expect(masks[1]).toBeGreaterThan(masks[2]);
    // Scaled softmax: exp(LOGIT_SCALE * 1) / exp(0) between the first two.
    expect(masks[0] / masks[1]).toBeCloseTo(Math.exp(LOGIT_SCALE), 4);
  });

  it("stays finite for very large logits", () => {
    const logits = new Float32Array(2 * STRIDE);
    logits[0] = 1e30;
    logits[STRIDE] = -1e30;
    logitsToMasks(logits, 2, 1);
    expect(logits[0]).toBe(1);
    expect(logits[STRIDE]).toBe(0);
  });
});
