import type { AnalysisRecord, BeatsPerBar, GridEdits } from "../types";
import { type LoopRegion, normalizeLoop } from "../practice";

/**
 * The beat grid everything uses (display, click, snapping, quick loops):
 * the detected beats with the user's corrections applied.
 */

export interface BeatGrid {
  /** Beat times, seconds, ascending. */
  beats: Float64Array;
  /** Tempo at the original speed. */
  bpm: number;
  beatsPerBar: BeatsPerBar;
  /** Index of a beat that starts a bar (0 ≤ firstDownbeat < beatsPerBar). */
  firstDownbeat: number;
  /** 0–1; below LOW_CONFIDENCE the grid is shown but not snapped to. */
  confidence: number;
}

/** Below this, the grid may well be wrong: no snapping, and a hint. */
export const LOW_CONFIDENCE = 0.3;
/** Tempo factors the ×2 and ÷2 buttons step through. */
export const MIN_BPM_FACTOR = 0.5;
export const MAX_BPM_FACTOR = 2;

/** `value` mod `n`, never negative. */
function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

export function effectiveGrid(record: AnalysisRecord): BeatGrid | null {
  const edits: GridEdits = record.edits ?? {};
  let beats: Float64Array;
  let firstDownbeat: number;
  let bpm: number;
  let confidence = record.bpmConfidence;
  if (edits.tapped) {
    const period = 60 / edits.tapped.bpm;
    const anchor = edits.tapped.anchor;
    const before = Math.floor(anchor / period);
    const count = Math.floor((record.duration - anchor) / period) + before + 1;
    beats = Float64Array.from({ length: Math.max(0, count) }, (_, i) =>
      anchor + (i - before) * period
    );
    // The last tap lands on a downbeat until shifted.
    firstDownbeat = before;
    bpm = edits.tapped.bpm;
    confidence = 1;
  } else {
    beats = Float64Array.from(record.beats);
    firstDownbeat = record.firstDownbeatIndex;
    bpm = record.bpm;
  }
  const factor = edits.bpmFactor ?? 1;
  if (factor === 2 && beats.length > 1) {
    const doubled = new Float64Array(beats.length * 2 - 1);
    for (let i = 0; i < beats.length; i++) {
      doubled[i * 2] = beats[i];
      if (i + 1 < beats.length) doubled[i * 2 + 1] = (beats[i] + beats[i + 1]) / 2;
    }
    beats = doubled;
    firstDownbeat *= 2;
    bpm *= 2;
  } else if (factor === 0.5 && beats.length > 1) {
    // Keep the beats in step with the downbeat, so bar starts stay.
    const parity = mod(firstDownbeat, 2);
    beats = beats.filter((_, i) => i % 2 === parity);
    firstDownbeat = (firstDownbeat - parity) / 2;
    bpm /= 2;
  }
  if (beats.length === 0) return null;
  const beatsPerBar = edits.beatsPerBar ?? record.beatsPerBar;
  return {
    beats,
    bpm,
    beatsPerBar,
    firstDownbeat: mod(firstDownbeat + (edits.downbeatShift ?? 0), beatsPerBar),
    confidence,
  };
}

/** Whether the grid's beat `index` starts a bar. */
export function isDownbeat(grid: BeatGrid, index: number): boolean {
  return mod(index - grid.firstDownbeat, grid.beatsPerBar) === 0;
}

/** Bar number (from 1) of beat `index`; beats before the first bar are bar 0. */
export function barNumber(grid: BeatGrid, index: number): number {
  return Math.floor((index - grid.firstDownbeat) / grid.beatsPerBar) + 1;
}

/** Time of beat `index`, extrapolated at the grid's tempo outside the beats. */
export function beatTime(grid: BeatGrid, index: number): number {
  const { beats } = grid;
  const period = 60 / grid.bpm;
  if (index < 0) return beats[0] + index * period;
  if (index >= beats.length) return beats[beats.length - 1] + (index - beats.length + 1) * period;
  return beats[index];
}

/** Index of the last beat at or before `seconds` (−1 if before the first). */
export function beatIndexAt(grid: BeatGrid, seconds: number): number {
  const { beats } = grid;
  let low = 0;
  let high = beats.length - 1;
  if (!(seconds >= beats[0])) return Math.floor((seconds - beats[0]) / (60 / grid.bpm));
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (beats[middle] <= seconds) low = middle;
    else high = middle - 1;
  }
  if (low === beats.length - 1) {
    return low + Math.floor((seconds - beats[low]) / (60 / grid.bpm));
  }
  return low;
}

/** The grid line (beat, or bar start) nearest to `seconds`. */
export function snapTime(grid: BeatGrid, seconds: number, to: "beat" | "bar"): number {
  const index = beatIndexAt(grid, seconds);
  if (to === "beat") {
    const before = beatTime(grid, index);
    const after = beatTime(grid, index + 1);
    return seconds - before <= after - seconds ? before : after;
  }
  const bar = barStartIndex(grid, index);
  const before = beatTime(grid, bar);
  const after = beatTime(grid, bar + grid.beatsPerBar);
  return seconds - before <= after - seconds ? before : after;
}

/** Index of the downbeat that starts the bar containing beat `index`. */
export function barStartIndex(grid: BeatGrid, index: number): number {
  return index - mod(index - grid.firstDownbeat, grid.beatsPerBar);
}

/**
 * A loop of `bars` bars from the start of the bar containing `position`,
 * kept inside the track.
 */
export function barLoop(
  grid: BeatGrid,
  position: number,
  bars: number,
  duration: number,
): LoopRegion | null {
  // A little ahead, so a playhead just before a downbeat counts as there.
  const start = barStartIndex(grid, beatIndexAt(grid, position + 0.02));
  return normalizeLoop(
    beatTime(grid, start),
    beatTime(grid, start + bars * grid.beatsPerBar),
    duration,
  );
}

/**
 * Bars a loop spans if it starts and ends on bar lines of `grid` (within a
 * few milliseconds), else null.
 */
export function loopBars(grid: BeatGrid, loop: LoopRegion): number | null {
  const tolerance = 0.03;
  const start = beatIndexAt(grid, loop.start + tolerance);
  if (!isDownbeat(grid, start) || Math.abs(beatTime(grid, start) - loop.start) > tolerance) {
    return null;
  }
  const end = beatIndexAt(grid, loop.end + tolerance);
  if (!isDownbeat(grid, end) || Math.abs(beatTime(grid, end) - loop.end) > tolerance) {
    return null;
  }
  const bars = (end - start) / grid.beatsPerBar;
  return bars >= 1 ? bars : null;
}

/** Tempo from tap times (seconds): the median of the last intervals. */
export function tapTempo(taps: number[]): number | null {
  const recent = taps.slice(-8);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);
  const usable = intervals.filter((interval) => interval > 0.2 && interval < 2);
  if (usable.length < 3) return null;
  usable.sort((a, b) => a - b);
  const middle = usable.length / 2;
  const median = usable.length % 2
    ? usable[Math.floor(middle)]
    : (usable[middle - 1] + usable[middle]) / 2;
  return Math.round((60 / median) * 10) / 10;
}

/** "120", or "120 → 102" when the speed changes what is heard. */
export function formatTempo(bpm: number, speed: number): string {
  const base = Math.round(bpm);
  const heard = Math.round(bpm * speed);
  return heard === base ? `${base}` : `${base} → ${heard}`;
}
