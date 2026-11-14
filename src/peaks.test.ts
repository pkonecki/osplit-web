import { describe, expect, it } from "vitest";
import { PeakBuilder, peaksFromChannels } from "./peaks";

describe("waveform peaks", () => {
  it("keeps the loudest sample of each part of the track", () => {
    // 4 frames into 2 buckets: frames 0–1 and 2–3.
    const builder = new PeakBuilder(4, 2);
    builder.push(Int16Array.from([1000, -2000, 500, 0]));
    builder.push(Int16Array.from([16384, 0, -32768, 100]));
    expect([...builder.result()]).toEqual([2000 / 32768, 1]);
  });

  it("gives the same result however the samples are pushed", () => {
    const pcm = Int16Array.from({ length: 2 * 1000 }, (_, i) => ((i * 37) % 2001) - 1000);
    const whole = new PeakBuilder(1000, 50);
    whole.push(pcm);
    const pieces = new PeakBuilder(1000, 50);
    for (let i = 0; i < pcm.length; i += 2 * 37) pieces.push(pcm.subarray(i, i + 2 * 37));
    expect(pieces.result()).toEqual(whole.result());
  });

  it("matches peaks computed from decoded channels", () => {
    const pcm = Int16Array.from({ length: 2 * 500 }, (_, i) => Math.round(Math.sin(i) * 20000));
    const builder = new PeakBuilder(500, 25);
    builder.push(pcm);
    const left = Float32Array.from({ length: 500 }, (_, i) => pcm[2 * i] / 32768);
    const right = Float32Array.from({ length: 500 }, (_, i) => pcm[2 * i + 1] / 32768);
    const decoded = peaksFromChannels(left, right, 25);
    decoded.forEach((peak, i) => expect(peak).toBeCloseTo(builder.result()[i], 6));
  });
});
