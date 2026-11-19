import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/demucs/stft.json";
import {
  DEMUCS_BINS,
  DEMUCS_FRAMES,
  DEMUCS_SEGMENT,
  DEMUCS_SOURCES,
  demucsInverse,
  demucsSegmentCount,
  demucsSpectrogram,
  meanStd,
  separateDemucs,
} from "./demucs";

const PLANE = DEMUCS_BINS * DEMUCS_FRAMES;
const TAU = 2 * Math.PI;

/** The fixture's test signal, planar stereo (see write_fixtures). */
function tones(): Float32Array {
  const out = new Float32Array(2 * DEMUCS_SEGMENT);
  for (let n = 0; n < DEMUCS_SEGMENT; n++) {
    out[n] = 0.5 * Math.sin(TAU * 440 * n / 44100) +
      0.25 * Math.sin(TAU * 1234.5 * n / 44100);
    out[DEMUCS_SEGMENT + n] = 0.4 * Math.sin(TAU * 97 * n / 44100) +
      0.3 * Math.cos(TAU * 5000 * n / 44100);
  }
  return out;
}

function energy(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
  return sum;
}

describe("Demucs STFT", () => {
  it("matches HTDemucs._spec", () => {
    const spec = demucsSpectrogram(tones());
    expect(spec.length).toBe(4 * PLANE);
    for (const [channel, bin, frame, re, im] of fixture.spec) {
      const cell = bin * DEMUCS_FRAMES + frame;
      expect(spec[2 * channel * PLANE + cell]).toBeCloseTo(re, 3);
      expect(spec[(2 * channel + 1) * PLANE + cell]).toBeCloseTo(im, 3);
    }
    expect(energy(spec) / fixture.specEnergy).toBeCloseTo(1, 5);
  });

  it("matches HTDemucs._ispec", () => {
    const spec = new Float32Array(4 * PLANE);
    for (const [bin, frame, re, im] of fixture.ispecInput) {
      spec[bin * DEMUCS_FRAMES + frame] = re; // left channel only
      spec[PLANE + bin * DEMUCS_FRAMES + frame] = im;
    }
    const out = demucsInverse(spec);
    for (const [n, value] of fixture.ispec) {
      expect(out[n]).toBeCloseTo(value, 6);
    }
    expect(energy(out.subarray(0, DEMUCS_SEGMENT)) / fixture.ispecEnergy)
      .toBeCloseTo(1, 4);
    // The right channel was silent.
    expect(energy(out.subarray(DEMUCS_SEGMENT))).toBeLessThan(1e-12);
  });

  it("gives the signal back away from the edges", () => {
    const signal = tones();
    const back = demucsInverse(demucsSpectrogram(signal));
    let worst = 0;
    for (const base of [0, DEMUCS_SEGMENT]) {
      for (let n = 4096; n < DEMUCS_SEGMENT - 4096; n++) {
        worst = Math.max(worst, Math.abs(back[base + n] - signal[base + n]));
      }
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it("computes mean and Bessel-corrected standard deviation", () => {
    const { mean, std } = meanStd(Float32Array.from([1, 2, 3, 4]));
    expect(mean).toBe(2.5);
    expect(std).toBeCloseTo(Math.sqrt(5 / 3), 12);
  });
});

describe("Demucs pipeline", () => {
  const { length, samples, energy: energies } = fixture.pipeline;

  function pipelineInput(): Float32Array {
    const out = new Float32Array(2 * length);
    for (let n = 0; n < length; n++) {
      out[2 * n] = 0.3 * Math.sin(TAU * 220 * n / 44100) + 0.1;
      out[2 * n + 1] = 0.2 * Math.sin(TAU * 3000 * n / 44100) *
        Math.sin(TAU * 0.5 * n / 44100);
    }
    return out;
  }

  /** The fixture's stand-in network: fixed gains per stem. */
  const fakeRun = (mix: Float32Array, spec: Float32Array) => {
    const wave = new Float32Array(6 * mix.length);
    const specs = new Float32Array(6 * spec.length);
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < mix.length; i++) wave[k * mix.length + i] = mix[i] * (k + 1) / 10;
      for (let i = 0; i < spec.length; i++) specs[k * spec.length + i] = spec[i] * (6 - k) / 10;
    }
    return Promise.resolve({ wave, specs });
  };

  it("matches the NumPy reference around the network", async () => {
    const stems = DEMUCS_SOURCES.map(() => new Float32Array(2 * length));
    const written = DEMUCS_SOURCES.map(() => 0);
    const progress: number[] = [];
    await separateDemucs(pipelineInput(), fakeRun, {
      onSamples(source, interleaved) {
        stems[source].set(interleaved, written[source]);
        written[source] += interleaved.length;
      },
      onSegment(done, total) {
        progress.push(done / total);
      },
    });
    expect(written).toEqual(DEMUCS_SOURCES.map(() => 2 * length));
    // 2.3 segments at a 75% stride: offsets 0, 1, 2 and 3 strides.
    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
    expect(demucsSegmentCount(length)).toBe(4);
    for (const [k, channel, i, value] of samples) {
      expect(stems[k][2 * i + channel]).toBeCloseTo(value, 4);
    }
    stems.forEach((stem, k) => {
      expect(energy(stem) / energies[k]).toBeCloseTo(1, 4);
    });
  });

  it("handles a track shorter than one segment", async () => {
    const short = pipelineInput().subarray(0, 2 * 44100);
    let frames = 0;
    await separateDemucs(short, fakeRun, {
      onSamples(source, interleaved) {
        if (source === 0) frames += interleaved.length / 2;
      },
    });
    expect(frames).toBe(44100);
  });

  it("stops when cancelled", async () => {
    await expect(
      separateDemucs(pipelineInput(), fakeRun, {
        onSamples() {},
        checkCancelled() {
          throw new DOMException("Separation cancelled.", "AbortError");
        },
      }),
    ).rejects.toThrow(/cancelled/);
  });
});
