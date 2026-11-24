import { chordName, pitchClass } from "./analysis/spelling";
import type { ChordSegment } from "./types";

/**
 * The capo: chords are named as the shapes played with a capo on fret
 * `capo`, the sounding chord transposed down by that many semitones. The
 * audio doesn't change. Suggestions pick the frets that make the song's
 * main chords open shapes.
 */

export const MAX_CAPO = 11;

/** The open shapes a beginner knows: C, A, G, E, D, Am, Em, Dm. */
const OPEN_SHAPES = new Set(["0:maj", "9:maj", "7:maj", "4:maj", "2:maj", "9:min", "4:min", "2:min"]);

export function clampCapo(value: number): number {
  return Math.max(0, Math.min(MAX_CAPO, Math.round(value) || 0));
}

/** A chord the song uses a lot: root (as heard) and quality, and how long it sounds. */
export interface MainChord {
  root: number;
  quality: "maj" | "min";
  seconds: number;
}

/** The song's chords by time sounding, most first (shifted by `semitones`), up to `count`. */
export function mainChords(chords: readonly ChordSegment[], semitones: number, count = 5): MainChord[] {
  const totals = new Map<string, MainChord>();
  for (const chord of chords) {
    if (chord.root === null) continue;
    const root = pitchClass(chord.root + semitones);
    const id = `${root}:${chord.quality}`;
    const entry = totals.get(id) ?? { root, quality: chord.quality, seconds: 0 };
    entry.seconds += chord.end - chord.start;
    totals.set(id, entry);
  }
  return [...totals.values()].sort((a, b) => b.seconds - a.seconds).slice(0, count);
}

/** The shape played for a sounding chord with the capo on `capo`, e.g. "G" for A on fret 2. */
export function shapeName(chord: Pick<MainChord, "root" | "quality">, capo: number): string {
  return chordName({ root: pitchClass(chord.root - capo), quality: chord.quality }, null, 0);
}

/** Share (0–1) of the main chords' time played as open shapes with the capo on `capo`. */
export function openShare(chords: readonly MainChord[], capo: number): number {
  const total = chords.reduce((sum, chord) => sum + chord.seconds, 0);
  if (!total) return 0;
  const open = chords
    .filter((chord) => OPEN_SHAPES.has(`${pitchClass(chord.root - capo)}:${chord.quality}`))
    .reduce((sum, chord) => sum + chord.seconds, 0);
  return open / total;
}

/** The `count` capo positions with the most open shapes (ties: the lower fret). */
export function suggestCapos(chords: readonly MainChord[], count = 3): { capo: number; share: number }[] {
  return Array.from({ length: MAX_CAPO + 1 }, (_, capo) => ({ capo, share: openShare(chords, capo) }))
    .sort((a, b) => b.share - a.share || a.capo - b.capo)
    .slice(0, count);
}
