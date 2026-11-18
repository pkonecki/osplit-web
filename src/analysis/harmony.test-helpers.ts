import type { ChordQuality } from "../types";
import { ANALYSIS_RATE } from "./onset";
import { seededRandom } from "./synthetic.test-helpers";

/**
 * Synthetic harmony for the tonal tests (no recorded audio in the
 * repository): sawtooth triads, a sine-ish bass line, quiet noise.
 */

export interface SynthChord {
  root: number;
  quality: ChordQuality;
  /** Bass note when not the root. */
  bass?: number;
}

export interface Progression {
  harmonic: Float32Array;
  bass: Float32Array;
  beats: number[];
  /** The chord sounding over each beat (index into `chords` repeated). */
  truth: { start: number; end: number; chord: SynthChord }[];
}

export interface ProgressionOptions {
  chords: SynthChord[];
  bpm?: number;
  beatsPerChord?: number;
  /** Times through the progression. */
  repeats?: number;
  /** Detuning of every note, cents. */
  cents?: number;
  seed?: number;
  /** A melody note (pitch class) per chord, played an octave up. */
  melody?: number[];
}

/** Adds a band-limited sawtooth at `midi` (with `cents`) into `out` over [from, to). */
export function addSaw(
  out: Float32Array,
  midi: number,
  from: number,
  to: number,
  level: number,
  cents = 0,
  harmonics = 10,
): void {
  const hz = 440 * 2 ** ((midi - 69 + cents / 100) / 12);
  const start = Math.round(from * ANALYSIS_RATE);
  const end = Math.min(out.length, Math.round(to * ANALYSIS_RATE));
  const fade = Math.round(0.01 * ANALYSIS_RATE);
  for (let h = 1; h <= harmonics && h * hz < ANALYSIS_RATE / 2; h++) {
    const step = (2 * Math.PI * h * hz) / ANALYSIS_RATE;
    const amplitude = level / h;
    for (let i = start; i < end; i++) {
      const envelope = Math.min(1, (i - start) / fade, (end - i) / fade);
      out[i] += amplitude * envelope * Math.sin(step * (i - start));
    }
  }
}

/** MIDI note of pitch class `pc` in the octave starting at `base`. */
function inOctave(pc: number, base: number): number {
  return base + ((pc - base) % 12 + 12) % 12;
}

export function progression(options: ProgressionOptions): Progression {
  const { chords, bpm = 100, beatsPerChord = 4, repeats = 2, cents = 0, seed = 1 } = options;
  const beat = 60 / bpm;
  const lead = 0.5;
  const chordSeconds = beat * beatsPerChord;
  const total = chords.length * repeats;
  const seconds = lead + total * chordSeconds + 0.5;
  const length = Math.round(seconds * ANALYSIS_RATE);
  const random = seededRandom(seed);
  const harmonic = new Float32Array(length);
  const bass = new Float32Array(length);
  for (let i = 0; i < length; i++) harmonic[i] = (random() - 0.5) * 0.002;
  const truth: Progression["truth"] = [];
  for (let n = 0; n < total; n++) {
    const chord = chords[n % chords.length];
    const from = lead + n * chordSeconds;
    const to = from + chordSeconds;
    const third = chord.quality === "maj" ? 4 : 3;
    const root = inOctave(chord.root, 55);
    for (const step of [0, third, 7]) addSaw(harmonic, root + step, from, to, 0.08, cents);
    const melody = options.melody?.[n % chords.length];
    if (melody !== undefined) addSaw(harmonic, inOctave(melody, 67), from, to, 0.05, cents);
    const bassNote = inOctave(chord.bass ?? chord.root, 36);
    addSaw(bass, bassNote, from, to, 0.15, cents, 3);
    truth.push({ start: from, end: to, chord });
  }
  // The bass stem is part of the harmonic input too.
  for (let i = 0; i < length; i++) harmonic[i] += bass[i];
  const beats: number[] = [];
  for (let n = 0; n < total * beatsPerChord; n++) beats.push(lead + n * beat);
  return { harmonic, bass, beats, truth };
}

/** Chords of a key by scale degree, e.g. degrees("major", 7, [1, 5, 6, 4]). */
export function degrees(mode: "major" | "minor", tonic: number, steps: number[]): SynthChord[] {
  const major: [number, ChordQuality][] = [[0, "maj"], [2, "min"], [4, "min"], [5, "maj"], [7, "maj"], [9, "min"], [11, "min"]];
  // Harmonic minor's V (major), natural minor otherwise.
  const minor: [number, ChordQuality][] = [[0, "min"], [2, "min"], [3, "maj"], [5, "min"], [7, "maj"], [8, "maj"], [10, "maj"]];
  return steps.map((degree) => {
    const [step, quality] = (mode === "major" ? major : minor)[degree - 1];
    return { root: (tonic + step) % 12, quality };
  });
}
