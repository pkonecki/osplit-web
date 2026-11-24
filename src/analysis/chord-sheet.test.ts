import { describe, expect, it } from "vitest";
import type { ChordSegment } from "../types";
import { barChords, chordIndexAt, chordSheet, labFile } from "./chord-sheet";
import type { BeatGrid } from "./grid";

/** 120 BPM, 4/4, beats every 0.5 s from 0.5 s; bars start at 0.5 s. */
const grid: BeatGrid = {
  beats: Float64Array.from({ length: 32 }, (_, i) => 0.5 + i * 0.5),
  bpm: 120,
  beatsPerBar: 4,
  firstDownbeat: 0,
  confidence: 1,
};
const chord = (start: number, end: number, root: number | null, quality: "maj" | "min" = "maj", bass?: number) => {
  const segment: ChordSegment = { start, end, root, quality };
  if (bass !== undefined) segment.bass = bass;
  return segment;
};
// Am F C G, a bar each, then C and G/B sharing a bar.
const chords = [
  chord(0, 0.5, null),
  chord(0.5, 2.5, 9, "min"),
  chord(2.5, 4.5, 5),
  chord(4.5, 6.5, 0),
  chord(6.5, 8.5, 7),
  chord(8.5, 9.5, 0),
  chord(9.5, 10.5, 7, "maj", 11),
  chord(10.5, 16.5, null),
];
const aMinor = { key: { tonic: 9, mode: "minor" as const }, semitones: 0 };

describe("chord sheet", () => {
  it("finds the chord at a time", () => {
    expect(chordIndexAt(chords, 0)).toBe(0);
    expect(chordIndexAt(chords, 2.5)).toBe(2);
    expect(chordIndexAt(chords, 9.49)).toBe(5);
    expect(chordIndexAt(chords, 20)).toBe(-1);
  });

  it("lists the chords of each bar", () => {
    expect(barChords(chords, grid, 16.5, aMinor)).toEqual(["Am", "F", "C", "G", "C G/B"]);
    // Transposed up 2 for B minor: re-spelled with sharps.
    expect(barChords(chords, grid, 16.5, { key: { tonic: 11, mode: "minor" }, semitones: 2 }))
      .toEqual(["Bm", "G", "D", "A", "D A/C#"]);
  });

  it("writes four bars a line", () => {
    const text = chordSheet(chords, grid, 16.5, aMinor, ["Song", "Key: A minor"]);
    expect(text).toBe(
      "Song\nKey: A minor\n\n| Am    | F     | C     | G     |\n| C G/B |\n",
    );
  });

  it("heads each marker's bars with its name", () => {
    const text = chordSheet(chords, grid, 16.5, aMinor, ["Song"], [
      { bar: 1, name: "Intro" },
      { bar: 3, name: "Verse" },
    ]);
    expect(text).toBe(
      "Song\n\n[Intro]\n| Am    | F     |\n\n[Verse]\n| C     | G     | C G/B |\n",
    );
  });

  it("lists chords with times without a grid", () => {
    expect(chordSheet(chords.slice(0, 3), null, 4.5, aMinor, ["Song"]))
      .toBe("Song\n\n0:00   Am\n0:02   F\n");
  });

  it("writes MIREX .lab lines", () => {
    expect(labFile(chords.slice(0, 2), aMinor)).toBe("0.000 0.500 N\n0.500 2.500 A:min\n");
    expect(labFile([chord(0, 1, 7, "maj", 11)], { key: null, semitones: 0 })).toBe("0.000 1.000 G:maj/3\n");
  });
});
