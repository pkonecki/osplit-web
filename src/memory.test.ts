import { describe, expect, it } from "vitest";
import {
  estimateSeparationBytes,
  isLongForDevice,
  playbackEngineFor,
} from "./memory";

const MB = 1024 ** 2;
const FRAMES_PER_MINUTE = 44_100 * 60;

describe("separation memory estimate", () => {
  it("grows with track length", () => {
    const oneMinute = estimateSeparationBytes(FRAMES_PER_MINUTE, "spleeter-5");
    const fiveMinutes = estimateSeparationBytes(5 * FRAMES_PER_MINUTE, "spleeter-5");
    expect(fiveMinutes).toBeGreaterThan(oneMinute);
    // Audio buffers per stereo frame: 8 bytes of float input, plus 4 bytes
    // of 16-bit PCM for each of the five stems and the one Blob copy.
    expect(fiveMinutes - oneMinute).toBe(4 * FRAMES_PER_MINUTE * (8 + 6 * 4));
  });

  it("counts Demucs's sixth stem and its working memory", () => {
    const spleeter = estimateSeparationBytes(FRAMES_PER_MINUTE, "spleeter-5");
    const demucs = estimateSeparationBytes(FRAMES_PER_MINUTE, "htdemucs-6s");
    // A smaller file, but a large working set per 7.8 s segment.
    expect(demucs - spleeter).toBeGreaterThan(1000 * MB);
    const perMinute = (model: "spleeter-5" | "htdemucs-6s") =>
      estimateSeparationBytes(2 * FRAMES_PER_MINUTE, model) -
      estimateSeparationBytes(FRAMES_PER_MINUTE, model);
    expect(perMinute("htdemucs-6s") - perMinute("spleeter-5")).toBe(FRAMES_PER_MINUTE * 4);
  });

  it("warns only past a quarter of the device memory", () => {
    expect(isLongForDevice(900 * MB, 4)).toBe(false);
    expect(isLongForDevice(1100 * MB, 4)).toBe(true);
    expect(isLongForDevice(1100 * MB, 8)).toBe(false);
    expect(isLongForDevice(10_000 * MB, undefined)).toBe(false);
    expect(isLongForDevice(10_000 * MB, Number.NaN)).toBe(false);
  });

  it("flags long tracks on a 4 GB phone but not short ones", () => {
    const longFor4Gb = (minutes: number) =>
      isLongForDevice(
        estimateSeparationBytes(minutes * FRAMES_PER_MINUTE, "spleeter-5"),
        4,
      );
    expect(longFor4Gb(1)).toBe(false);
    expect(longFor4Gb(8)).toBe(true);
    // A computer with 8 GB or more handles a 10-minute track.
    expect(
      isLongForDevice(estimateSeparationBytes(10 * FRAMES_PER_MINUTE, "spleeter-5"), 8),
    ).toBe(false);
  });
});

describe("playback engine choice", () => {
  it("plays from decoded buffers unless they are too much for the device", () => {
    const fiveMinutes = 5 * FRAMES_PER_MINUTE;
    // 5 stems × 5 minutes decoded is about 265 MB.
    expect(playbackEngineFor(fiveMinutes, 5, 8)).toBe("buffer");
    expect(playbackEngineFor(fiveMinutes, 5, 4)).toBe("buffer");
    expect(playbackEngineFor(fiveMinutes, 5, 1)).toBe("media");
    expect(playbackEngineFor(20 * FRAMES_PER_MINUTE, 5, 4)).toBe("media");
    // Unknown device memory (Firefox, Safari): decoded buffers.
    expect(playbackEngineFor(20 * FRAMES_PER_MINUTE, 5, undefined)).toBe("buffer");
  });
});

