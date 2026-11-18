import { describe, expect, it } from "vitest";
import type { AnalysisRecord } from "../types";
import { renderClickTrack } from "./click";
import {
  barLoop,
  barNumber,
  beatIndexAt,
  effectiveGrid,
  formatTempo,
  isDownbeat,
  loopBars,
  snapTime,
  tapTempo,
} from "./grid";

/** 120 BPM from 1 s, 4/4 with the first downbeat on beat 1 (1.5 s). */
function record(changes: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    projectId: "p",
    algorithmVersion: 1,
    source: "drums",
    duration: 20,
    bpm: 120,
    bpmConfidence: 0.8,
    alternativeBpm: 60,
    beats: Float32Array.from({ length: 36 }, (_, i) => 1 + i * 0.5),
    beatsPerBar: 4,
    firstDownbeatIndex: 1,
    ...changes,
  };
}

describe("effective grid", () => {
  it("uses the detected grid without edits", () => {
    const grid = effectiveGrid(record())!;
    expect(grid.bpm).toBe(120);
    expect(grid.beats.length).toBe(36);
    expect(grid.firstDownbeat).toBe(1);
    expect(isDownbeat(grid, 1)).toBe(true);
    expect(isDownbeat(grid, 5)).toBe(true);
    expect(isDownbeat(grid, 2)).toBe(false);
    expect(barNumber(grid, 0)).toBe(0);
    expect(barNumber(grid, 1)).toBe(1);
    expect(barNumber(grid, 9)).toBe(3);
  });

  it("doubles the tempo by adding beats halfway", () => {
    const grid = effectiveGrid(record({ edits: { bpmFactor: 2 } }))!;
    expect(grid.bpm).toBe(240);
    expect(grid.beats.length).toBe(71);
    expect(grid.beats[1]).toBeCloseTo(1.25);
    // The old downbeat (1.5 s) is still one.
    expect(grid.beats[2]).toBeCloseTo(1.5);
    expect(isDownbeat(grid, 2)).toBe(true);
  });

  it("halves the tempo keeping the downbeats", () => {
    const grid = effectiveGrid(record({ edits: { bpmFactor: 0.5 } }))!;
    expect(grid.bpm).toBe(60);
    expect(grid.beats[0]).toBeCloseTo(1.5);
    expect(grid.beats[1]).toBeCloseTo(2.5);
    expect(isDownbeat(grid, 0)).toBe(true);
  });

  it("shifts the downbeat and changes the metre", () => {
    expect(effectiveGrid(record({ edits: { downbeatShift: 1 } }))!.firstDownbeat).toBe(2);
    expect(effectiveGrid(record({ edits: { downbeatShift: -2 } }))!.firstDownbeat).toBe(3);
    const waltz = effectiveGrid(record({ edits: { beatsPerBar: 3 } }))!;
    expect(waltz.beatsPerBar).toBe(3);
    expect(isDownbeat(waltz, 4)).toBe(true);
  });

  it("replaces the grid with an even one from tap tempo", () => {
    const grid = effectiveGrid(record({ edits: { tapped: { bpm: 100, anchor: 3 } } }))!;
    expect(grid.bpm).toBe(100);
    expect(grid.confidence).toBe(1);
    expect(grid.beats[0]).toBeCloseTo(0);
    expect(grid.beats[1]).toBeCloseTo(0.6);
    expect(grid.beats.at(-1)!).toBeLessThanOrEqual(20);
    const anchor = [...grid.beats].findIndex((time) => Math.abs(time - 3) < 1e-9);
    expect(isDownbeat(grid, anchor)).toBe(true);
  });

  it("is null without beats", () => {
    expect(effectiveGrid(record({ beats: new Float32Array() }))).toBeNull();
  });
});

describe("positions on the grid", () => {
  const grid = effectiveGrid(record())!;

  it("finds the beat at a time, extrapolating outside the beats", () => {
    expect(beatIndexAt(grid, 1)).toBe(0);
    expect(beatIndexAt(grid, 1.74)).toBe(1);
    expect(beatIndexAt(grid, 0.6)).toBe(-1);
    expect(beatIndexAt(grid, 19.6)).toBe(37);
  });

  it("snaps to beats and bars", () => {
    expect(snapTime(grid, 2.2, "beat")).toBeCloseTo(2);
    expect(snapTime(grid, 2.3, "beat")).toBeCloseTo(2.5);
    expect(snapTime(grid, 2.2, "bar")).toBeCloseTo(1.5);
    expect(snapTime(grid, 3.0, "bar")).toBeCloseTo(3.5);
  });

  it("makes bar loops from the bar containing the playhead", () => {
    expect(barLoop(grid, 2.7, 1, 20)).toEqual({ start: 1.5, end: 3.5 });
    expect(barLoop(grid, 3.49, 2, 20)).toEqual({ start: 3.5, end: 7.5 });
    // Kept inside the track.
    expect(barLoop(grid, 19, 4, 20)!.end).toBe(20);
  });

  it("recognises loops on bar lines", () => {
    expect(loopBars(grid, { start: 1.5, end: 3.5 })).toBe(1);
    expect(loopBars(grid, { start: 1.5, end: 9.5 })).toBe(4);
    expect(loopBars(grid, { start: 2, end: 4 })).toBeNull();
  });
});

describe("tap tempo", () => {
  it("takes the median interval of recent taps", () => {
    expect(tapTempo([0, 0.5, 1, 1.5])).toBe(120);
    expect(tapTempo([0, 0.6, 1.2, 1.8, 5])).toBe(100);
    expect(tapTempo([0, 0.5])).toBeNull();
  });
});

describe("click track", () => {
  const grid = effectiveGrid(record())!;

  it("places a click on each beat, louder on downbeats", () => {
    const rate = 8000;
    const track = renderClickTrack(grid, { start: 0, end: 20, speed: 1 }, rate, 20 * rate);
    expect(track.length).toBe(160_000);
    const peak = (seconds: number) =>
      Math.max(...track.subarray(seconds * rate, seconds * rate + 240).map(Math.abs));
    expect(peak(1)).toBeGreaterThan(0.1);
    expect(peak(1.5)).toBeGreaterThan(peak(1));
    expect(peak(1.2)).toBe(0);
  });

  it("follows the region and speed", () => {
    const rate = 8000;
    const track = renderClickTrack(grid, { start: 1.5, end: 3.5, speed: 0.5 }, rate, 4 * rate);
    const onsets = [];
    for (let i = 1; i < track.length; i++) if (track[i] !== 0 && track[i - 1] === 0) onsets.push(i);
    // Beats at 1.5, 2, 2.5, 3 s heard at 0, 1, 2, 3 s.
    expect(onsets).toEqual([1, 8001, 16001, 24001]);
  });
});

describe("tempo display", () => {
  it("shows the heard tempo when the speed changes it", () => {
    expect(formatTempo(120.2, 1)).toBe("120");
    expect(formatTempo(120, 0.85)).toBe("120 → 102");
  });
});
