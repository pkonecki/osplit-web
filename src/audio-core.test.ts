import { describe, expect, it } from "vitest";
import {
  encodeWav,
  fftInPlace,
  mixWavBlobs,
  readWavFrames,
  resampleStereo,
} from "./audio-core";

describe("audio primitives", () => {
  it("resamples stereo audio to 44.1 kHz with the expected duration", () => {
    const result = resampleStereo(
      new Float32Array([0, 1, 0, -1]),
      new Float32Array([1, 0, -1, 0]),
      22_050,
    );
    expect(result).toHaveLength(16);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(1);
    expect(result[2]).toBeCloseTo(0.5);
  });

  it("round-trips an FFT input through forward and inverse transforms", () => {
    const real = new Float32Array([1, 0, -1, 0, 0.5, 0, -0.5, 0]);
    const original = real.slice();
    const imaginary = new Float32Array(real.length);
    fftInPlace(real, imaginary, false);
    fftInPlace(real, imaginary, true);
    real.forEach((value, index) => expect(value).toBeCloseTo(original[index], 5));
    imaginary.forEach((value) => expect(value).toBeCloseTo(0, 5));
  });

  it("writes stereo PCM WAV with a valid header and exact frame count", async () => {
    const samples = new Float32Array([0.25, -0.25, 0.5, -0.5]);
    const wav = encodeWav(samples, 2);
    expect(wav.type).toBe("audio/wav");
    const view = new DataView(await wav.arrayBuffer());
    expect(readWavFrames(view)).toBe(2);
    expect(view.getInt16(44, true)).toBe(8192);
    expect(view.getInt16(46, true)).toBe(-8192);
  });

  it("mixes enabled stems and normalizes only when their peak would clip", async () => {
    const first = encodeWav(new Float32Array([0.75, -0.75]), 1);
    const second = encodeWav(new Float32Array([0.75, -0.75]), 1);
    const result = await mixWavBlobs([first, second], [1, 1]);
    const view = new DataView(await result.arrayBuffer());
    expect(view.getInt16(44, true)).toBe(32766);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it("preserves the level of mixes below full scale", async () => {
    const input = encodeWav(new Float32Array([0.2, -0.2]), 1);
    const result = await mixWavBlobs([input], [1]);
    const view = new DataView(await result.arrayBuffer());
    expect(view.getInt16(44, true)).toBe(6553);
  });
});

describe("PCM conversion", () => {
  it("rounds and clamps like the WAV encoder", async () => {
    const { toPcm16 } = await import("./audio-core");
    expect(toPcm16(0)).toBe(0);
    expect(toPcm16(1)).toBe(32767);
    expect(toPcm16(-1)).toBe(-32768);
    expect(toPcm16(2)).toBe(32767);
    expect(toPcm16(-2)).toBe(-32768);
    expect(toPcm16(0.25)).toBe(8192);
  });
});

describe("interleaveStereo", () => {
  it("matches resampleStereo at 44.1 kHz exactly", async () => {
    const { interleaveStereo, resampleStereo } = await import("./audio-core");
    const left = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i * 0.37));
    const right = Float32Array.from({ length: 5000 }, (_, i) => Math.cos(i * 0.11));
    expect(interleaveStereo(left, right)).toEqual(resampleStereo(left, right, 44_100));
    expect(() => interleaveStereo(new Float32Array(0), new Float32Array(0)))
      .toThrow(/no decodable samples/);
  });
});
