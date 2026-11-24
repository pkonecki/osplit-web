import { describe, expect, it } from "vitest";
import { effectiveGrid } from "../analysis/grid";
import type { AnalysisRecord } from "../types";
import { countInClicks } from "../analysis/click";
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
      { when: expect.closeTo(100.1, 9), kind: "accent" },
    ]);
    expect(clicksAhead(grid, timeline({ position: 2.05 }), 100, 0.12)).toEqual([]);
  });

  it("allows for the speed", () => {
    // Half speed: the beat 0.05 s of track ahead is heard in 0.1 s.
    expect(clicksAhead(grid, timeline({ position: 1.45, rate: 0.5 }), 10, 0.12)).toEqual([
      { when: expect.closeTo(10.1, 9), kind: "beat" },
    ]);
    // 1.5×: 0.12 s covers 0.18 s of track.
    expect(clicksAhead(grid, timeline({ position: 1.35, rate: 1.5 }), 0, 0.12).length).toBe(1);
  });

  it("wraps at the loop end", () => {
    const loop = { start: 1, end: 1.95 };
    const clicks = clicksAhead(grid, timeline({ position: 1.9, loop }), 50, 0.12);
    // 0.05 s to the loop end, then the beat at the loop start.
    expect(clicks).toEqual([{ when: expect.closeTo(50.05, 9), kind: "beat" }]);
  });

  it("includes a beat exactly at the position", () => {
    expect(clicksAhead(grid, timeline({ position: 3 }), 0, 0.05)).toEqual([
      { when: 0, kind: "beat" },
    ]);
  });

  it("stops at the end of the track", () => {
    expect(clicksAhead(grid, timeline({ position: 9.95, duration: 10 }), 0, 0.5)).toEqual([]);
  });

  it("adds softer clicks between beats", () => {
    // 8ths: a click every 0.25 s; the beat at 0.5 s is plain.
    const clicks = clicksAhead(grid, timeline({ position: 0.3 }), 0, 0.5, { accent: true, subdivision: 2 });
    expect(clicks.map((click) => [Math.round(click.when * 100) / 100, click.kind])).toEqual([
      [0.2, "beat"],
      [0.45, "sub"],
    ]);
  });

  it("leaves the accent out when it is off", () => {
    expect(clicksAhead(grid, timeline({ position: 1.95 }), 0, 0.1, { accent: false, subdivision: 1 }))
      .toEqual([{ when: expect.closeTo(0.05, 9), kind: "beat" }]);
  });
});

describe("count-in", () => {
  it("plays a bar of beats, accenting its first", () => {
    const clicks = countInClicks(3, 0.5, 1, 10, { accent: true, subdivision: 1 });
    expect(clicks).toEqual([
      { when: 10, kind: "accent" },
      { when: 10.5, kind: "beat" },
      { when: 11, kind: "beat" },
    ]);
    expect(countInClicks(4, 0.5, 2, 0, { accent: true, subdivision: 3 })).toHaveLength(24);
  });
});

describe("metre", () => {
  it("uses a time signature set by hand", () => {
    const record = {
      projectId: "p",
      algorithmVersion: 1,
      source: "drums" as const,
      duration: 10,
      bpm: 120,
      bpmConfidence: 1,
      alternativeBpm: null,
      beats: Float32Array.from({ length: 20 }, (_, i) => i * 0.5),
      beatsPerBar: 4 as const,
      firstDownbeatIndex: 0,
      edits: { beatsPerBar: 3 as const, metre: { beats: 6, unit: 8 as const } },
    };
    const sixEight = effectiveGrid(record)!;
    expect(sixEight.beatsPerBar).toBe(6);
    expect(sixEight.beatUnit).toBe(8);
    // Accents every sixth beat.
    const accents = clicksAhead(sixEight, timeline({ position: 0 }), 0, 6)
      .filter((click) => click.kind === "accent")
      .map((click) => click.when);
    expect(accents).toEqual([0, 3]);
  });
});
