import { describe, expect, it } from "vitest";
import { encodeWavPcm16 } from "./audio-core";
import { detectAudioFormat, stemFrameCount } from "./audio-format";
import { encodeFlac } from "./flac";

describe("stem headers", () => {
  const pcm = new Int16Array(2 * 12_345).map((_, i) => (i * 37) % 2000 - 1000);

  it("reads the frame count of FLAC and WAV stems without decoding", async () => {
    expect(await stemFrameCount(encodeFlac(pcm))).toBe(12_345);
    expect(await stemFrameCount(encodeWavPcm16(pcm))).toBe(12_345);
  });

  it("detects the format from the MIME type or the first bytes", async () => {
    expect(await detectAudioFormat(encodeFlac(pcm))).toBe("flac");
    expect(await detectAudioFormat(encodeWavPcm16(pcm))).toBe("wav");
    const untypedFlac = new Blob([await encodeFlac(pcm).arrayBuffer()]);
    expect(await detectAudioFormat(untypedFlac)).toBe("flac");
    await expect(detectAudioFormat(new Blob(["nope"]))).rejects.toThrow(/unknown/);
    await expect(stemFrameCount(new Blob(["nope"]))).rejects.toThrow(/unknown/);
  });
});
