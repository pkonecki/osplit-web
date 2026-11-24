import { describe, expect, it } from "vitest";
import type { ChordSegment } from "../types";
import { barIndexAt, beatInBar, chartBars, peakSlices, stepBar } from "./chart";
import type { BeatGrid } from "./grid";

/** 120 BPM in 4/4 from 0 s: a bar every 2 s. */
function grid(seconds: number, firstDownbeat = 0): BeatGrid {
  return {
    beats: Float64Array.from({ length: seconds * 2 }, (_, i) => i * 0.5),
    bpm: 120,
    beatsPerBar: 4,
    firstDownbeat,
    confidence: 1,
  };
}

const C = (start: number, end: number): ChordSegment => ({ start, end, root: 0, quality: "maj" });
const G = (start: number, end: number): ChordSegment => ({ start, end, root: 7, quality: "maj" });
const NC = (start: number, end: number): ChordSegment => ({ start, end, root: null, quality: "maj" });
const naming = { key: { tonic: 0, mode: "major" as const }, semitones: 0 };

describe("chord chart", () => {
  it("lists each bar with its chords, a change inside a bar in turn", () => {
    const bars = chartBars([C(0, 3), G(3, 8)], grid(8), 8, naming);
    expect(bars.map((bar) => bar.chords)).toEqual([["C"], ["C", "G"], ["G"], ["G"]]);
    expect(bars.map((bar) => [bar.number, bar.start, bar.end])).toEqual([
      [1, 0, 2],
      [2, 2, 4],
      [3, 4, 6],
      [4, 6, 8],
    ]);
  });

  it("drops silent bars at the ends but keeps rests inside", () => {
    const bars = chartBars([NC(0, 2), C(2, 4), NC(4, 6), G(6, 8), NC(8, 10)], grid(10), 10, naming);
    expect(bars.map((bar) => bar.chords.join(" "))).toEqual(["C", "N.C.", "G"]);
    expect(bars[0].number).toBe(2);
  });

  it("names chords in the shifted key", () => {
    const bars = chartBars([C(0, 2)], grid(2), 2, { key: { tonic: 2, mode: "major" }, semitones: 2 });
    expect(bars[0].chords).toEqual(["D"]);
  });

  it("numbers bars from the first downbeat", () => {
    // Bar 1 starts on the second beat: the beat before is bar 0.
    const bars = chartBars([C(0, 8)], grid(8, 1), 8, naming);
    expect(bars[0]).toMatchObject({ number: 0, beat: -3 });
    expect(bars[1]).toMatchObject({ number: 1, beat: 1, start: 0.5 });
  });

  it("finds the bar and beat at a time", () => {
    const bars = chartBars([C(0, 8)], grid(8), 8, naming);
    expect(barIndexAt(bars, 0)).toBe(0);
    expect(barIndexAt(bars, 5.9)).toBe(2);
    expect(barIndexAt(bars, 9)).toBe(-1);
    expect(beatInBar(grid(8), 2.6)).toBe(1);
  });

  it("steps to the previous and next bar", () => {
    const g = grid(8);
    expect(stepBar(g, 2.6, 1)).toBe(4);
    // Well into a bar, back goes to its start; near the start, a bar back.
    expect(stepBar(g, 3.2, -1)).toBe(2);
    expect(stepBar(g, 2.2, -1)).toBe(0);
  });

  it("slices peaks for a bar", () => {
    const peaks = Float32Array.from({ length: 100 }, (_, i) => i / 100);
    expect(peakSlices(peaks, 10, 0, 2, 2)).toEqual([Math.fround(0.09), Math.fround(0.19)]);
    expect(peakSlices(new Float32Array(), 10, 0, 2, 2)).toEqual([]);
  });
});
