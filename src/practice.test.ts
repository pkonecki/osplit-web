import { describe, expect, it } from "vitest";
import {
  activeLoop,
  busTranspose,
  clampSemitones,
  clampSpeed,
  formatPrecise,
  formatSemitones,
  formatSpeed,
  isNeutral,
  loopWithEnd,
  loopWithStart,
  normalizeLoop,
  nudgeLoopEdge,
  projectSemitones,
  projectSpeed,
  seekTarget,
  wrapPosition,
} from "./practice";
import { newProject, type Project } from "./types";

function project(changes: Partial<Project> = {}): Project {
  return { ...newProject("practice"), ...changes };
}

describe("speed and key", () => {
  it("defaults projects saved before practice settings to neutral", () => {
    expect(projectSpeed(project())).toBe(1);
    expect(projectSemitones(project())).toBe(0);
    expect(isNeutral(project())).toBe(true);
    expect(isNeutral(project({ speed: 0.8 }))).toBe(false);
    expect(isNeutral(project({ loop: { start: 1, end: 2, enabled: false } })))
      .toBe(false);
  });

  it("clamps and rounds", () => {
    expect(clampSpeed(0.2)).toBe(0.5);
    expect(clampSpeed(2)).toBe(1.5);
    expect(clampSpeed(0.8549)).toBe(0.85);
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSemitones(13)).toBe(12);
    expect(clampSemitones(-20)).toBe(-12);
    expect(clampSemitones(2.4)).toBe(2);
    expect(clampSemitones(Number.NaN)).toBe(0);
  });

  it("formats", () => {
    expect(formatSpeed(0.85)).toBe("85%");
    expect(formatSpeed(1)).toBe("100%");
    expect(formatSemitones(0)).toBe("Original");
    expect(formatSemitones(2)).toBe("+2");
    expect(formatSemitones(-3)).toBe("−3");
    expect(formatPrecise(62.44)).toBe("1:02.4");
    expect(formatPrecise(0)).toBe("0:00.0");
    expect(formatPrecise(59.96)).toBe("1:00.0");
  });
});

describe("pitch shifter setting", () => {
  it("is off at neutral settings", () => {
    expect(busTranspose("buffer", 1, 0)).toBe(0);
    expect(busTranspose("media", 1, 0)).toBe(0);
  });

  it("corrects the pitch change of resampled buffers", () => {
    // Half speed lowers the pitch an octave; the shifter raises it back.
    expect(busTranspose("buffer", 0.5, 0)).toBeCloseTo(12);
    expect(busTranspose("buffer", 2 ** (1 / 12), 0)).toBeCloseTo(-1);
    expect(busTranspose("buffer", 0.5, -2)).toBeCloseTo(10);
  });

  it("only shifts the key of streaming elements, which keep their pitch", () => {
    expect(busTranspose("media", 0.5, 0)).toBe(0);
    expect(busTranspose("media", 0.75, 3)).toBe(3);
  });
});

describe("loop", () => {
  it("is active only when enabled and long enough", () => {
    expect(activeLoop(project())).toBeNull();
    expect(activeLoop(project({ loop: { start: 1, end: 2, enabled: false } })))
      .toBeNull();
    expect(activeLoop(project({ loop: { start: 1, end: 1.1, enabled: true } })))
      .toBeNull();
    expect(activeLoop(project({ loop: { start: 1, end: 2, enabled: true } })))
      .toEqual({ start: 1, end: 2 });
  });

  it("normalizes regions", () => {
    expect(normalizeLoop(5, 2, 10)).toEqual({ start: 2, end: 5 });
    expect(normalizeLoop(-1, 12, 10)).toEqual({ start: 0, end: 10 });
    expect(normalizeLoop(3, 3.1, 10)).toEqual({ start: 3, end: 3.25 });
    expect(normalizeLoop(9.9, 10, 10)).toEqual({ start: 9.75, end: 10 });
    expect(normalizeLoop(0, 0.1, 0.1)).toBeNull();
  });

  it("sets A and B at the playhead", () => {
    // A without a loop: runs to the end of the track, not yet on.
    expect(loopWithStart(undefined, 3, 10)).toEqual({ start: 3, end: 10, enabled: false });
    // B keeps a start before it and turns the loop on.
    expect(loopWithEnd({ start: 3, end: 10, enabled: false }, 6, 10))
      .toEqual({ start: 3, end: 6, enabled: true });
    // B before A starts the loop at the beginning of the track.
    expect(loopWithEnd({ start: 3, end: 6, enabled: true }, 2, 10))
      .toEqual({ start: 0, end: 2, enabled: true });
    // A after B keeps the loop state and runs to the end.
    expect(loopWithStart({ start: 3, end: 6, enabled: true }, 7, 10))
      .toEqual({ start: 7, end: 10, enabled: true });
    expect(loopWithStart({ start: 3, end: 6, enabled: true }, 4, 10))
      .toEqual({ start: 4, end: 6, enabled: true });
  });

  it("nudges one edge, keeping the minimum length", () => {
    const loop = { start: 2, end: 4, enabled: true };
    expect(nudgeLoopEdge(loop, "start", 0.1, 10)).toEqual({ start: 2.1, end: 4, enabled: true });
    expect(nudgeLoopEdge(loop, "end", -1, 10)).toEqual({ start: 2, end: 3, enabled: true });
    expect(nudgeLoopEdge(loop, "start", 5, 10)).toEqual({ start: 3.75, end: 4, enabled: true });
    expect(nudgeLoopEdge(loop, "end", 10, 10)).toEqual({ start: 2, end: 10, enabled: true });
    expect(nudgeLoopEdge(loop, "start", -5, 10)).toEqual({ start: 0, end: 4, enabled: true });
  });

  it("wraps positions past the end back into the loop", () => {
    const loop = { start: 2, end: 4 };
    expect(wrapPosition(3.5, loop)).toBe(3.5);
    expect(wrapPosition(1, loop)).toBe(1);
    expect(wrapPosition(4, loop)).toBe(2);
    expect(wrapPosition(5.5, loop)).toBeCloseTo(3.5);
    expect(wrapPosition(9, loop)).toBeCloseTo(3);
    expect(wrapPosition(9, null)).toBe(9);
  });

  it("sends seeks after the loop to its start", () => {
    const loop = { start: 2, end: 4 };
    expect(seekTarget(1, 10, loop)).toBe(1);
    expect(seekTarget(3, 10, loop)).toBe(3);
    expect(seekTarget(6, 10, loop)).toBe(2);
    expect(seekTarget(12, 10, null)).toBe(10);
    expect(seekTarget(-1, 10, null)).toBe(0);
  });
});
