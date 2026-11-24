import { describe, expect, it } from "vitest";
import { clampCapo, mainChords, openShare, shapeName, suggestCapos } from "./capo";
import type { ChordSegment } from "./types";

const chord = (start: number, end: number, root: number | null, quality: "maj" | "min" = "maj"): ChordSegment => ({
  start,
  end,
  root,
  quality,
});

// B♭ F Gm E♭: no open shapes at fret 0; with the capo on 3, G D Em C.
const song = [chord(0, 4, 10), chord(4, 8, 5), chord(8, 10, 7, "min"), chord(10, 12, 3), chord(12, 13, null)];

describe("capo", () => {
  it("keeps the capo on a fret", () => {
    expect(clampCapo(-1)).toBe(0);
    expect(clampCapo(14)).toBe(11);
    expect(clampCapo(2.4)).toBe(2);
  });

  it("finds the main chords, most heard first, shifted with the key", () => {
    expect(mainChords(song, 0).map((item) => [item.root, item.quality])).toEqual([
      [10, "maj"],
      [5, "maj"],
      [7, "min"],
      [3, "maj"],
    ]);
    expect(mainChords(song, 2)[0].root).toBe(0);
  });

  it("names the shapes played with the capo", () => {
    expect(shapeName({ root: 9, quality: "maj" }, 2)).toBe("G");
    expect(shapeName({ root: 10, quality: "maj" }, 3)).toBe("G");
    expect(shapeName({ root: 7, quality: "min" }, 3)).toBe("Em");
  });

  it("suggests the frets with the most open shapes", () => {
    const main = mainChords(song, 0);
    expect(openShare(main, 0)).toBe(0);
    expect(openShare(main, 3)).toBe(1);
    expect(suggestCapos(main)[0]).toEqual({ capo: 3, share: 1 });
    expect(suggestCapos(main)).toHaveLength(3);
  });
});
