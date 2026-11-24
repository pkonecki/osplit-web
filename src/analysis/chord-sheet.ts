import type { ChordSegment, MusicalKey } from "../types";
import { type BeatGrid, barStartIndex, beatTime } from "./grid";
import { chartBars } from "./chart";
import { chordName, pitchClass, pitchName } from "./spelling";

/**
 * Chord timelines as text: a chord sheet with four bars a line, and `.lab`
 * files (MIREX: "start end label") for DAWs and analysis tools.
 */

/** How chords are named: spelled for `key`, transposed by `semitones`. */
export interface ChordNaming {
  key: MusicalKey | null;
  semitones: number;
}

/** The chord sounding at `time`, if any (binary search; segments are in order). */
export function chordIndexAt(chords: ChordSegment[], time: number): number {
  let low = 0;
  let high = chords.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (time < chords[middle].start) high = middle - 1;
    else if (time >= chords[middle].end) low = middle + 1;
    else return middle;
  }
  return -1;
}

export function nameChord(chord: ChordSegment, naming: ChordNaming): string {
  return chordName(chord, naming.key, naming.semitones);
}

const BARS_PER_LINE = 4;
const CELL_WIDTH = 6;

/**
 * The chords of each bar of the grid (from the bar holding the first beat),
 * as names; a bar whose chord changes lists each in turn ("C G").
 */
export function barChords(
  chords: ChordSegment[],
  grid: BeatGrid,
  duration: number,
  naming: ChordNaming,
): string[] {
  const bars: string[] = [];
  const quarter = 15 / grid.bpm;
  for (let start = barStartIndex(grid, 0); beatTime(grid, start) < duration; start += grid.beatsPerBar) {
    const names: string[] = [];
    for (let beat = start; beat < start + grid.beatsPerBar; beat++) {
      const time = beatTime(grid, beat) + quarter;
      if (time < 0 || time >= duration) continue;
      const index = chordIndexAt(chords, time);
      const name = index < 0 ? "N.C." : nameChord(chords[index], naming);
      if (names[names.length - 1] !== name) names.push(name);
    }
    if (names.length) bars.push(names.join(" "));
  }
  // Silence before the music and after it isn't worth a line.
  while (bars[0] === "N.C.") bars.shift();
  while (bars[bars.length - 1] === "N.C.") bars.pop();
  return bars;
}

/**
 * A plain-text chord sheet: a short header, then `| Am  | F   | C   | G   |`
 * lines. With markers, each heads its bars as `[Chorus]`, its lines
 * starting afresh.
 */
export function chordSheet(
  chords: ChordSegment[],
  grid: BeatGrid | null,
  duration: number,
  naming: ChordNaming,
  header: string[],
  markers: readonly { bar: number; name: string }[] = [],
): string {
  const lines = [...header, ""];
  if (grid) {
    const bars = chartBars(chords, grid, duration, naming);
    let line: string[] = [];
    const flush = () => {
      if (line.length) lines.push(`|${line.map((bar) => ` ${bar.padEnd(CELL_WIDTH)}`).join("|")}|`);
      line = [];
    };
    for (const bar of bars) {
      const marker = markers.find((item) => item.bar === bar.number);
      if (marker) {
        flush();
        if (lines[lines.length - 1] !== "") lines.push("");
        lines.push(`[${marker.name}]`);
      }
      line.push(bar.chords.join(" "));
      if (line.length === BARS_PER_LINE) flush();
    }
    flush();
  } else {
    // No beat grid: one chord a line, with its time.
    for (const chord of chords) {
      if (chord.root === null) continue;
      lines.push(`${formatClock(chord.start).padEnd(7)}${nameChord(chord, naming)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** MIREX label: "A:min", "C:maj", "C:maj/3", "N". */
export function labLabel(chord: ChordSegment, naming: ChordNaming): string {
  if (chord.root === null) return "N";
  const root = pitchName(chord.root + naming.semitones, naming.key);
  let label = `${root}:${chord.quality}`;
  if (chord.bass !== undefined) {
    const interval = pitchClass(chord.bass - chord.root);
    const degree = interval === 7 ? "5" : interval === 4 ? "3" : interval === 3 ? "b3" : null;
    if (degree) label += `/${degree}`;
  }
  return label;
}

export function labFile(chords: ChordSegment[], naming: ChordNaming): string {
  return chords
    .map((chord) => `${chord.start.toFixed(3)} ${chord.end.toFixed(3)} ${labLabel(chord, naming)}\n`)
    .join("");
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
