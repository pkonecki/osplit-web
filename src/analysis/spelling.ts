import type { ChordSegment, MusicalKey } from "../types";

/**
 * Names for pitch classes, keys and chords, spelled with sharps or flats as
 * the key signature has them ("F#" in D major, "Gb" in Db major).
 */

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** Major tonics written with flats: F, Bb, Eb, Ab, Db (F# major keeps sharps). */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]);
/** Minor tonics written with flats: D, G, C, F, Bb, Eb (G# minor keeps sharps). */
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);

export function pitchClass(value: number): number {
  return ((Math.round(value) % 12) + 12) % 12;
}

/** Whether the key's signature has flats (C major and A minor have neither: sharps). */
export function keyUsesFlats(key: MusicalKey): boolean {
  return (key.mode === "major" ? FLAT_MAJOR : FLAT_MINOR).has(pitchClass(key.tonic));
}

/** The name of a pitch class, spelled for `key` (sharps when there is none). */
export function pitchName(pc: number, key?: MusicalKey | null): string {
  return (key && keyUsesFlats(key) ? FLAT_NAMES : SHARP_NAMES)[pitchClass(pc)];
}

/** "A minor", "F# major", spelled for the key itself. */
export function keyName(key: MusicalKey): string {
  return `${pitchName(key.tonic, key)} ${key.mode}`;
}

export function sameKey(a: MusicalKey | null | undefined, b: MusicalKey | null | undefined): boolean {
  return Boolean(a && b && pitchClass(a.tonic) === pitchClass(b.tonic) && a.mode === b.mode);
}

export function transposeKey(key: MusicalKey, semitones: number): MusicalKey {
  return { tonic: pitchClass(key.tonic + semitones), mode: key.mode };
}

/** The relative minor of a major key, or the relative major of a minor one. */
export function relativeKey(key: MusicalKey): MusicalKey {
  return key.mode === "major"
    ? { tonic: pitchClass(key.tonic + 9), mode: "minor" }
    : { tonic: pitchClass(key.tonic + 3), mode: "major" };
}

/** All 24 keys, C major first, then by tonic. */
export const ALL_KEYS: MusicalKey[] = Array.from({ length: 24 }, (_, i) => ({
  tonic: Math.floor(i / 2),
  mode: i % 2 ? "minor" : "major",
}));

/** "Am", "C", "C/E", or "N.C." for no chord; transposed by `semitones`, spelled for `key`. */
export function chordName(
  chord: Pick<ChordSegment, "root" | "quality" | "bass">,
  key?: MusicalKey | null,
  semitones = 0,
): string {
  if (chord.root === null) return "N.C.";
  const root = pitchName(chord.root + semitones, key);
  const bass = chord.bass === undefined ? "" : `/${pitchName(chord.bass + semitones, key)}`;
  return `${root}${chord.quality === "min" ? "m" : ""}${bass}`;
}

/** Chords that belong to the key (diatonic triads; minor keys add the major V). */
export function diatonicChords(key: MusicalKey): { root: number; quality: "maj" | "min" }[] {
  const steps: [number, "maj" | "min"][] = key.mode === "major"
    ? [[0, "maj"], [2, "min"], [4, "min"], [5, "maj"], [7, "maj"], [9, "min"]]
    : [[0, "min"], [3, "maj"], [5, "min"], [7, "min"], [7, "maj"], [8, "maj"], [10, "maj"]];
  return steps.map(([step, quality]) => ({ root: pitchClass(key.tonic + step), quality }));
}
