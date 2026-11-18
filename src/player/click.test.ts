import { describe, expect, it } from "vitest";
import { effectiveGrid } from "../analysis/grid";
import type { AnalysisRecord } from "../types";
import { type ClickTimeline, clicksAhead } from "./click";

// 120 BPM: beats every 0.5 s from 0, 4/4 from beat 0.
const grid = effectiveGrid({
  projectId: "p",
  algorithmVersion: 1,
  source: "drums",
  duration: 10,
  bpm: 120,
  bpmConfidence: 1,
  alternativeBpm: null,
  beats: Float32Array.from({ length: 20 }, (_, i) => i * 0.5),
  beatsPerBar: 4,
  firstDownbeatIndex: 0,
} satisfies AnalysisRecord)!;

function timeline(changes: Partial<ClickTimeline> = {}): ClickTimeline {
  return { position: 0, playing: true, rate: 1, duration: 10, loop: null, ...changes };
}

describe("click look-ahead", () => {
  it("converts beats ahead to audio-clock time", () => {
    expect(clicksAhead(grid, timeline({ position: 1.9 }), 100, 0.12)).toEqual([
      { when: expect.closeTo(100.1, 9), accent: true },
    ]);
    expect(clicksAhead(grid, timeline({ position: 2.05 }), 100, 0.12)).toEqual([]);
  });

  it("allows for the speed", () => {
    // Half speed: the beat 0.05 s of track ahead is heard in 0.1 s.
    expect(clicksAhead(grid, timeline({ position: 1.45, rate: 0.5 }), 10, 0.12)).toEqual([
      { when: expect.closeTo(10.1, 9), accent: false },
    ]);
    // 1.5×: 0.12 s covers 0.18 s of track.
    expect(clicksAhead(grid, timeline({ position: 1.35, rate: 1.5 }), 0, 0.12).length).toBe(1);
  });

  it("wraps at the loop end", () => {
    const loop = { start: 1, end: 1.95 };
    const clicks = clicksAhead(grid, timeline({ position: 1.9, loop }), 50, 0.12);
    // 0.05 s to the loop end, then the beat at the loop start.
    expect(clicks).toEqual([{ when: expect.closeTo(50.05, 9), accent: false }]);
  });

  it("includes a beat exactly at the position", () => {
    expect(clicksAhead(grid, timeline({ position: 3 }), 0, 0.05)).toEqual([
      { when: 0, accent: false },
    ]);
  });

  it("stops at the end of the track", () => {
    expect(clicksAhead(grid, timeline({ position: 9.95, duration: 10 }), 0, 0.5)).toEqual([]);
  });
});
