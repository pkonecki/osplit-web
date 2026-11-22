/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { crc32, crc32OfBlob, createZip, dosDateTime, readZip } from "./zip";

const workDir = mkdtempSync(join(tmpdir(), "osplit-zip-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const ENTRIES = [
  { name: "Song-vocals.flac", data: new Blob([new Uint8Array(5000).fill(7)]) },
  { name: "Chanson épique-mix.wav", data: new Blob(["RIFF fake wav"]) },
  { name: "empty.txt", data: new Blob([]) },
];

describe("ZIP writer", () => {
  it("computes the standard CRC-32 check value, in one go or in pieces", async () => {
    const check = new TextEncoder().encode("123456789");
    expect(crc32(check)).toBe(0xcbf43926);
    expect(crc32(check.subarray(4), crc32(check.subarray(0, 4)))).toBe(0xcbf43926);
    expect(await crc32OfBlob(new Blob([check]))).toBe(0xcbf43926);
  });

  it("encodes dates and times in MS-DOS format", () => {
    const { date, time } = dosDateTime(new Date(2026, 10, 14, 13, 45, 31));
    expect(date).toBe(((2026 - 1980) << 9) | (11 << 5) | 14);
    expect(time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it("writes an archive that Python's zipfile reads and verifies", async () => {
    const zip = await createZip(ENTRIES, new Date(2026, 10, 14, 12, 0, 0));
    expect(zip.type).toBe("application/zip");
    const file = join(workDir, "stems.zip");
    writeFileSync(file, new Uint8Array(await zip.arrayBuffer()));
    // `-t` checks every file's CRC; the script lists names and sizes.
    execFileSync("python3", ["-m", "zipfile", "-t", file]);
    const listing = execFileSync("python3", [
      "-c",
      "import json, sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); " +
      "print(json.dumps([[i.filename, i.file_size, i.compress_type, i.date_time] for i in z.infolist()]))",
      file,
    ]).toString();
    expect(JSON.parse(listing)).toEqual([
      ["Song-vocals.flac", 5000, 0, [2026, 11, 14, 12, 0, 0]],
      ["Chanson épique-mix.wav", 13, 0, [2026, 11, 14, 12, 0, 0]],
      ["empty.txt", 0, 0, [2026, 11, 14, 12, 0, 0]],
    ]);
  });

  it("lays out headers, data and the central directory", async () => {
    const zip = new Uint8Array(await (await createZip(ENTRIES)).arrayBuffer());
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(3);
    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    // Data follows each local header unchanged.
    const nameLength = view.getUint16(26, true);
    expect(zip[30 + nameLength]).toBe(7);
    expect(zip.length).toBe(
      ENTRIES.reduce(
        (sum, entry) =>
          sum + 30 + 46 + 2 * new TextEncoder().encode(entry.name).length + entry.data.size,
        22,
      ),
    );
  });
});

describe("ZIP reader", () => {
  it("reads back what the writer wrote, with names, data and CRCs", async () => {
    const files = await readZip(await createZip(ENTRIES));
    expect(files.map((file) => file.name)).toEqual(ENTRIES.map((entry) => entry.name));
    for (const [i, file] of files.entries()) {
      const expected = new Uint8Array(await ENTRIES[i].data.arrayBuffer());
      expect(new Uint8Array(await file.data.arrayBuffer())).toEqual(expected);
      expect(file.crc).toBe(await crc32OfBlob(ENTRIES[i].data));
    }
  });

  it("reads stored archives written by other tools, with a comment", async () => {
    const file = join(workDir, "python.zip");
    execFileSync("python3", [
      "-c",
      "import sys, zipfile\n" +
      "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as z:\n" +
      "  z.comment = b'made by python'\n" +
      "  z.writestr('dir/a.txt', 'hello')\n" +
      "  z.writestr('b.bin', bytes(range(256)))\n",
      file,
    ]);
    const files = await readZip(new Blob([readFileSync(file)]));
    expect(files.map((entry) => entry.name)).toEqual(["dir/a.txt", "b.bin"]);
    expect(await files[0].data.text()).toBe("hello");
    expect(files[1].data.size).toBe(256);
  });

  it("refuses compressed archives", async () => {
    const file = join(workDir, "deflated.zip");
    execFileSync("python3", [
      "-c",
      "import sys, zipfile\n" +
      "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n" +
      "  z.writestr('a.txt', 'hello ' * 100)\n",
      file,
    ]);
    await expect(readZip(new Blob([readFileSync(file)]))).rejects.toThrow(/Compressed/);
  });

  it("refuses files that are not ZIP archives, or are cut short", async () => {
    await expect(readZip(new Blob(["not a zip at all"]))).rejects.toThrow(/damaged/);
    await expect(readZip(new Blob([]))).rejects.toThrow(/damaged/);
    const zip = await createZip(ENTRIES);
    // Cut in the middle of the data: the end record is gone.
    await expect(readZip(zip.slice(0, 3000))).rejects.toThrow(/damaged/);
  });
});
