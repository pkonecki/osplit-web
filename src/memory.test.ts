import { describe, expect, it } from "vitest";
import { estimateSeparationBytes, isLongForDevice } from "./memory";

const MB = 1024 ** 2;
const FRAMES_PER_MINUTE = 44_100 * 60;

describe("separation memory estimate", () => {
  it("grows with track length and model quality", () => {
    const oneMinute = estimateSeparationBytes(FRAMES_PER_MINUTE, "fp16");
    const fiveMinutes = estimateSeparationBytes(5 * FRAMES_PER_MINUTE, "fp16");
    expect(fiveMinutes).toBeGreaterThan(oneMinute);
    expect(estimateSeparationBytes(FRAMES_PER_MINUTE, "fp32")).toBeGreaterThan(
      oneMinute,
    );
    // Audio buffers per stereo frame: 8 bytes of float input, plus 4 bytes
    // of 16-bit PCM for each of the five stems and the one Blob copy.
    expect(fiveMinutes - oneMinute).toBe(4 * FRAMES_PER_MINUTE * (8 + 6 * 4));
  });

  it("warns only past a quarter of the device memory", () => {
    expect(isLongForDevice(900 * MB, 4)).toBe(false);
    expect(isLongForDevice(1100 * MB, 4)).toBe(true);
    expect(isLongForDevice(1100 * MB, 8)).toBe(false);
    expect(isLongForDevice(10_000 * MB, undefined)).toBe(false);
    expect(isLongForDevice(10_000 * MB, Number.NaN)).toBe(false);
  });

  it("flags long tracks on a 4 GB phone but not ordinary songs", () => {
    const longFor4Gb = (minutes: number, quality: "fp16" | "fp32") =>
      isLongForDevice(
        estimateSeparationBytes(minutes * FRAMES_PER_MINUTE, quality),
        4,
      );
    expect(longFor4Gb(4, "fp16")).toBe(false);
    expect(longFor4Gb(8, "fp16")).toBe(true);
    // High quality models need about 300 MB more.
    expect(longFor4Gb(4, "fp32")).toBe(true);
    // A computer with 8 GB or more handles a 10-minute track.
    expect(
      isLongForDevice(estimateSeparationBytes(10 * FRAMES_PER_MINUTE, "fp16"), 8),
    ).toBe(false);
  });
});
