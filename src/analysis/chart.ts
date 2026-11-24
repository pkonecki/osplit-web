import type { ChordSegment } from "../types";
import { chordIndexAt, type ChordNaming, nameChord } from "./chord-sheet";
import { type BeatGrid, barStartIndex, beatIndexAt, beatTime } from "./grid";

/**
 * The chord chart: the song as bars of the beat grid, each with its chords
 * and its place in time. Without a grid, the chords alone, in time order.
 */

export interface ChartBar {
  /** Bar number from 1 (the bar holding the first beat may be 0). */
  number: number;
  /** Index of the downbeat that starts the bar. */
  beat: number;
  start: number;
  end: number;
  /** The chords heard in the bar, in turn ("C", or "C", "G"); "N.C." for none. */
  chords: string[];
}

/** Bars of `grid` across the track, with their chords; silent bars at the ends are left out. */
export function chartBars(
  chords: ChordSegment[],
  grid: BeatGrid,
  duration: number,
  naming: ChordNaming,
): ChartBar[] {
  const bars: ChartBar[] = [];
  // Each beat's chord is read a sixteenth after it, past the attack.
  const offset = 15 / grid.bpm;
  const first = barStartIndex(grid, 0);
  for (let beat = first; beatTime(grid, beat) < duration; beat += grid.beatsPerBar) {
    const start = Math.max(0, beatTime(grid, beat));
    const end = Math.min(duration, beatTime(grid, beat + grid.beatsPerBar));
    if (end <= start) continue;
    const names: string[] = [];
    for (let index = beat; index < beat + grid.beatsPerBar; index++) {
      const time = beatTime(grid, index) + offset;
      if (time < 0 || time >= duration) continue;
      const at = chordIndexAt(chords, time);
      const name = at < 0 || chords[at].root === null ? "N.C." : nameChord(chords[at], naming);
      if (names[names.length - 1] !== name) names.push(name);
    }
    bars.push({
      number: Math.floor((beat - grid.firstDownbeat) / grid.beatsPerBar) + 1,
      beat,
      start,
      end,
      chords: names.length ? names : ["N.C."],
    });
  }
  const silent = (bar: ChartBar) => bar.chords.length === 1 && bar.chords[0] === "N.C.";
  // Keep silent bars inside the song: they are rests.
  let from = 0;
  let to = bars.length;
  while (from < to && silent(bars[from])) from++;
  while (to > from && silent(bars[to - 1])) to--;
  return from < to ? bars.slice(from, to) : bars;
}

/** Index in `bars` of the bar playing at `seconds`, or −1 outside them. */
export function barIndexAt(bars: readonly ChartBar[], seconds: number): number {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (seconds < bars[middle].start) high = middle - 1;
    else if (seconds >= bars[middle].end) low = middle + 1;
    else return middle;
  }
  return -1;
}

/** Beat within its bar (0-based) at `seconds`. */
export function beatInBar(grid: BeatGrid, seconds: number): number {
  const index = beatIndexAt(grid, seconds + 0.02);
  return index - barStartIndex(grid, index);
}

/**
 * Where the previous or next bar button goes from `position`: the next bar
 * line, or the start of the current bar, unless the playhead is within
 * `grace` seconds of it, then the bar before.
 */
export function stepBar(grid: BeatGrid, position: number, direction: -1 | 1, grace = 0.5): number {
  const bar = barStartIndex(grid, beatIndexAt(grid, position + 0.02));
  if (direction === 1) return beatTime(grid, bar + grid.beatsPerBar);
  const start = beatTime(grid, bar);
  return position - start > grace ? start : beatTime(grid, bar - grid.beatsPerBar);
}

/** The loudest of `peaks` (spanning `duration`) in `count` slices from `start` to `end`. */
export function peakSlices(
  peaks: Float32Array,
  duration: number,
  start: number,
  end: number,
  count: number,
): number[] {
  if (!(duration > 0) || !peaks.length) return [];
  const slices: number[] = [];
  const perSecond = peaks.length / duration;
  for (let i = 0; i < count; i++) {
    const from = Math.floor((start + ((end - start) * i) / count) * perSecond);
    const to = Math.max(from + 1, Math.floor((start + ((end - start) * (i + 1)) / count) * perSecond));
    let level = 0;
    for (let j = Math.max(0, from); j < to && j < peaks.length; j++) level = Math.max(level, peaks[j]);
    slices.push(level);
  }
  return slices;
}
