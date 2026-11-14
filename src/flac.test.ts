/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BitWriter,
  computeFixedResidual,
  crc16,
  crc8,
  encodeFlac,
  FLAC_BLOCK_SIZE,
  FlacEncoder,
} from "./flac";

/**
 * Encoded files are checked with an independent decoder: the reference `flac`
 * tool when installed (CI installs it), otherwise FFmpeg. Both verify every
 * frame's CRC; the decoded samples must equal the input exactly.
 */
function findDecoder(): "flac" | "ffmpeg" {
  for (const tool of ["flac", "ffmpeg"] as const) {
    try {
      execFileSync(tool, [tool === "flac" ? "--version" : "-version"], {
        stdio: "ignore",
      });
      return tool;
    } catch {
      // Try the next tool.
    }
  }
  throw new Error("Install the flac tool or FFmpeg to run the FLAC tests.");
}

const decoder = findDecoder();
const workDir = mkdtempSync(join(tmpdir(), "osplit-flac-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

async function decode(blob: Blob, name: string): Promise<Int16Array> {
  const file = join(workDir, `${name}.flac`);
  writeFileSync(file, new Uint8Array(await blob.arrayBuffer()));
  let raw: Buffer;
  if (decoder === "flac") {
    execFileSync("flac", ["--test", "--silent", file]);
    raw = execFileSync("flac", [
      "--decode", "--stdout", "--silent", "--force-raw-format",
      "--endian=little", "--sign=signed", file,
    ], { maxBuffer: 1 << 30 });
  } else {
    raw = execFileSync("ffmpeg", [
      "-v", "error", "-xerror", "-i", file, "-f", "s16le", "-acodec", "pcm_s16le", "-",
    ], { maxBuffer: 1 << 30 });
  }
  return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
}

function stereo(
  frames: number,
  left: (i: number) => number,
  right: (i: number) => number = left,
): Int16Array {
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    samples[i * 2] = left(i);
    samples[i * 2 + 1] = right(i);
  }
  return samples;
}

let seed = 2024;
function noise(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.round((seed / 2147483648) * 65535) - 32768;
}

const FRAMES = FLAC_BLOCK_SIZE * 3 + 1234; // three full blocks and a short one
const SIGNALS: Record<string, () => Int16Array> = {
  silence: () => stereo(FRAMES, () => 0),
  "DC level": () => stereo(FRAMES, () => -1234, () => 5678),
  sine: () =>
    stereo(
      FRAMES,
      (i) => Math.round(20000 * Math.sin(i * 0.031)),
      (i) => Math.round(15000 * Math.sin(i * 0.047 + 1)),
    ),
  "white noise": () => stereo(FRAMES, noise, noise),
  "full-scale square": () =>
    stereo(FRAMES, (i) => (Math.floor(i / 50) % 2 ? 32767 : -32768)),
  "identical channels": () => {
    const mono = Array.from({ length: FRAMES }, () => noise() >> 4);
    return stereo(FRAMES, (i) => mono[i]);
  },
  "opposite channels": () => {
    const mono = Array.from({ length: FRAMES }, (_, i) =>
      Math.round(30000 * Math.sin(i * 0.01)));
    return stereo(FRAMES, (i) => mono[i], (i) => -mono[i]);
  },
  "extremes per channel": () => stereo(FRAMES, () => 32767, () => -32768),
  "one short block": () => stereo(100, (i) => i * 300 - 15000),
  "a few samples": () => stereo(3, (i) => [32767, -32768, 0][i]),
};

describe("FLAC encoder", () => {
  for (const [name, make] of Object.entries(SIGNALS)) {
    it(`round-trips ${name} losslessly`, async () => {
      const input = make();
      const blob = encodeFlac(input);
      expect(blob.type).toBe("audio/flac");
      const decoded = await decode(blob, name.replace(/\W+/g, "-"));
      expect(decoded.length).toBe(input.length);
      let mismatches = 0;
      for (let i = 0; i < input.length; i++) {
        if (decoded[i] !== input[i]) mismatches++;
      }
      expect(mismatches).toBe(0);
    });
  }

  it("compresses silence and tonal audio far below WAV size", () => {
    const wavBytes = FRAMES * 4;
    expect(encodeFlac(SIGNALS.silence()).size).toBeLessThan(wavBytes / 100);
    expect(encodeFlac(SIGNALS.sine()).size).toBeLessThan(wavBytes * 0.7);
    // Noise cannot be compressed; it must not grow much beyond raw size.
    expect(encodeFlac(SIGNALS["white noise"]()).size).toBeLessThan(
      wavBytes * 1.02,
    );
  });

  it("gives the same file however the samples are pushed", async () => {
    const input = SIGNALS.sine();
    const whole = new Uint8Array(await encodeFlac(input).arrayBuffer());
    const encoder = new FlacEncoder();
    for (let start = 0; start < input.length; start += 2 * 777) {
      encoder.push(input.subarray(start, Math.min(input.length, start + 2 * 777)));
    }
    const pieces = new Uint8Array(await encoder.finish().arrayBuffer());
    expect(pieces).toEqual(whole);
  });

  it("writes a STREAMINFO header with the stream's totals", async () => {
    const input = SIGNALS.sine();
    const bytes = new Uint8Array(await encodeFlac(input).arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("fLaC");
    expect(bytes[4]).toBe(0x80); // last metadata block, STREAMINFO
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(8)).toBe(FLAC_BLOCK_SIZE);
    // Sample rate (20 bits), channels − 1 (3), bits − 1 (5), total (36 bits).
    const rate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
    expect(rate).toBe(44_100);
    expect((bytes[20] >> 1) & 0b111).toBe(1);
    expect(((bytes[20] & 1) << 4) | (bytes[21] >> 4)).toBe(15);
    const total = (bytes[21] & 0x0f) * 2 ** 32 + view.getUint32(22);
    expect(total).toBe(FRAMES);
  });

  it("refuses samples after finishing and unpaired samples", () => {
    const encoder = new FlacEncoder();
    expect(() => encoder.push(new Int16Array(3))).toThrow(/pairs/);
    encoder.finish();
    expect(() => encoder.push(new Int16Array(2))).toThrow(/finished/);
  });
});

describe("FLAC building blocks", () => {
  it("computes the FLAC CRC-8 and CRC-16 check values", () => {
    const check = new TextEncoder().encode("123456789");
    expect(crc8(check)).toBe(0xf4);
    expect(crc16(check)).toBe(0xfee8);
  });

  it("writes bit fields, unary and Rice codes MSB first", () => {
    const writer = new BitWriter(16);
    writer.write(0b101, 3);
    writer.writeUnary(2); // 001
    writer.writeRice(-3, 1); // folded 5: unary(2) = 001, low bit 1
    writer.writeSigned(-1, 4); // 1111
    writer.alignToByte();
    // 101 001 001 1 1111 + pad → 1010 0100 1111 1100
    expect([...writer.bytes.subarray(0, writer.byteLength)]).toEqual([
      0b10100100, 0b11111100,
    ]);
  });

  it("writes fields wider than 24 bits", () => {
    const writer = new BitWriter(8);
    writer.write(0x123456789, 36);
    writer.alignToByte();
    expect([...writer.bytes.subarray(0, writer.byteLength)]).toEqual([
      0x12, 0x34, 0x56, 0x78, 0x90,
    ]);
  });

  it("predicts polynomials exactly with the matching fixed order", () => {
    const n = 64;
    const cubic = Int32Array.from({ length: n }, (_, i) => i * i * i - 5 * i);
    const residual = new Int32Array(n);
    computeFixedResidual(cubic, n, 4, residual);
    expect([...residual.subarray(4)].every((value) => value === 0)).toBe(true);
    computeFixedResidual(cubic, n, 3, residual);
    expect(new Set(residual.subarray(3)).size).toBe(1); // constant third difference
  });
});
