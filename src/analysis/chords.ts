import type { ChordQuality, ChordSegment, MusicalKey } from "../types";
import { pearson } from "./key";
import { diatonicChords } from "./spelling";

/**
 * Chords: each beat's chroma is compared with templates of the 24 major and
 * minor triads (and "no chord"), helped by the bass stem's lowest notes and
 * the key; a Viterbi pass then picks the likeliest sequence, so a chord
 * doesn't flicker from beat to beat.
 */

export interface ChordLabel {
  /** null: no chord. */
  root: number | null;
  quality: ChordQuality;
}

/** State i < 24: root ⌊i/2⌋, major when even; state 24: no chord. */
export const CHORD_STATES: ChordLabel[] = [
  ...Array.from({ length: 24 }, (_, i): ChordLabel => ({
    root: i >> 1,
    quality: i % 2 ? "min" : "maj",
  })),
  { root: null, quality: "maj" },
];
const NO_CHORD = 24;

/** Harmonics in the templates, and how fast they fade (log chroma keeps them strong). */
const HARMONICS = 4;
const HARMONIC_DECAY = 0.6;
/** Scale from correlation to log-likelihood. */
const SHARPNESS = 10;
/** Score of "no chord" for a sounding segment (correlation units). */
const NO_CHORD_SCORE = 0.2;
/** A segment this much quieter than the median is silence: no chord. */
const SILENCE_RATIO = 0.1;
/** Bonus when the bass note is the chord's root, or another chord tone. */
const BASS_ROOT_BONUS = 0.1;
const BASS_TONE_BONUS = 0.07;
/** Bonus for chords that belong to the key. */
const DIATONIC_BONUS = 0.05;
/** Chance of keeping the same chord at the next beat (higher without beats). */
export const SELF_TRANSITION = 0.8;
export const SELF_TRANSITION_NO_BEATS = 0.9;
/** A slash chord needs its bass note to lead in this share of the segment's beats. */
const SLASH_SHARE = 0.75;

export function chordTones(label: ChordLabel): number[] {
  if (label.root === null) return [];
  return [0, label.quality === "maj" ? 4 : 3, 7].map((step) => (label.root! + step) % 12);
}

/** A triad's expected chroma: its notes and their first few harmonics. */
function template(label: ChordLabel): Float64Array {
  const values = new Float64Array(12);
  for (const tone of chordTones(label)) {
    for (let h = 1; h <= HARMONICS; h++) {
      values[(tone + Math.round(12 * Math.log2(h))) % 12] += HARMONIC_DECAY ** (h - 1);
    }
  }
  return values;
}

const TEMPLATES = CHORD_STATES.slice(0, NO_CHORD).map(template);

export interface ChordInput {
  /** segments × 12, L2-normalised harmonic chroma. */
  vectors: Float32Array;
  energy: Float32Array;
  /** segments × 12 bass-stem chroma, if there is a bass stem. */
  bass?: Float32Array;
  bassEnergy?: Float32Array;
  /** Segment boundaries, seconds (segments + 1). */
  boundaries: ArrayLike<number>;
  key: MusicalKey | null;
  selfTransition?: number;
}

/** Per segment, the index of the loudest bass pitch class, or -1 when the bass is quiet. */
function bassNotes(input: ChordInput): Int8Array {
  const count = input.energy.length;
  const notes = new Int8Array(count).fill(-1);
  if (!input.bass || !input.bassEnergy) return notes;
  const typical = median(input.bassEnergy);
  for (let segment = 0; segment < count; segment++) {
    if (!(input.bassEnergy[segment] > typical * 0.3 && typical > 0)) continue;
    let best = 0;
    let second = 0;
    let note = -1;
    for (let pc = 0; pc < 12; pc++) {
      const value = input.bass[segment * 12 + pc];
      if (value > best) {
        second = best;
        best = value;
        note = pc;
      } else if (value > second) {
        second = value;
      }
    }
    // Only a clearly leading note counts.
    if (best > second * 1.2) notes[segment] = note;
  }
  return notes;
}

/** Score of each state for each segment (segments × 25), in correlation units. */
export function chordScores(input: ChordInput): Float64Array {
  const count = input.energy.length;
  const states = CHORD_STATES.length;
  const scores = new Float64Array(count * states);
  const typical = median(input.energy);
  const diatonic = new Set(
    input.key ? diatonicChords(input.key).map((c) => c.root * 2 + (c.quality === "min" ? 1 : 0)) : [],
  );
  const notes = bassNotes(input);
  const vector = new Float64Array(12);
  for (let segment = 0; segment < count; segment++) {
    const offset = segment * states;
    const silent = !(input.energy[segment] > typical * SILENCE_RATIO);
    if (silent) {
      for (let state = 0; state < NO_CHORD; state++) scores[offset + state] = -1;
      scores[offset + NO_CHORD] = 1;
      continue;
    }
    for (let pc = 0; pc < 12; pc++) vector[pc] = input.vectors[segment * 12 + pc];
    for (let state = 0; state < NO_CHORD; state++) {
      let score = pearson(vector, TEMPLATES[state]);
      const label = CHORD_STATES[state];
      const bass = notes[segment];
      if (bass >= 0) {
        if (bass === label.root) score += BASS_ROOT_BONUS;
        else if (chordTones(label).includes(bass)) score += BASS_TONE_BONUS;
      }
      if (diatonic.has(state)) score += DIATONIC_BONUS;
      scores[offset + state] = score;
    }
    scores[offset + NO_CHORD] = NO_CHORD_SCORE;
  }
  return scores;
}

/** The likeliest state sequence for `scores` (segments × states). */
export function viterbi(scores: Float64Array, states: number, selfTransition: number): Int32Array {
  const count = scores.length / states;
  const path = new Int32Array(count);
  if (count === 0) return path;
  const stay = Math.log(selfTransition);
  const move = Math.log((1 - selfTransition) / (states - 1));
  let previous = new Float64Array(states);
  let current = new Float64Array(states);
  const back = new Int32Array(count * states);
  for (let state = 0; state < states; state++) previous[state] = SHARPNESS * scores[state];
  for (let segment = 1; segment < count; segment++) {
    // The best state to move from is the same for every target but itself.
    let best = 0;
    for (let state = 1; state < states; state++) if (previous[state] > previous[best]) best = state;
    for (let state = 0; state < states; state++) {
      const fromSelf = previous[state] + stay;
      const fromBest = previous[best] + move;
      const from = best !== state && fromBest > fromSelf ? best : state;
      back[segment * states + state] = from;
      current[state] = (from === state ? fromSelf : fromBest) +
        SHARPNESS * scores[segment * states + state];
    }
    [previous, current] = [current, previous];
  }
  let last = 0;
  for (let state = 1; state < states; state++) if (previous[state] > previous[last]) last = state;
  path[count - 1] = last;
  for (let segment = count - 1; segment > 0; segment--) {
    path[segment - 1] = back[segment * states + path[segment]];
  }
  return path;
}

/** The chord timeline: likeliest chord per segment, equal neighbours merged. */
export function detectChords(input: ChordInput): ChordSegment[] {
  const count = input.energy.length;
  if (count === 0) return [];
  const scores = chordScores(input);
  const path = viterbi(scores, CHORD_STATES.length, input.selfTransition ?? SELF_TRANSITION);
  const notes = bassNotes(input);
  const segments: ChordSegment[] = [];
  let first = 0;
  for (let segment = 1; segment <= count; segment++) {
    if (segment < count && path[segment] === path[first]) continue;
    const label = CHORD_STATES[path[first]];
    const chord: ChordSegment = {
      start: input.boundaries[first],
      end: input.boundaries[segment],
      root: label.root,
      quality: label.quality,
    };
    const bass = slashBass(label, notes, first, segment);
    if (bass !== undefined) chord.bass = bass;
    segments.push(chord);
    first = segment;
  }
  return segments;
}

/** A chord tone other than the root that leads the bass throughout segments [from, to). */
function slashBass(label: ChordLabel, notes: Int8Array, from: number, to: number): number | undefined {
  if (label.root === null) return undefined;
  const counts = new Map<number, number>();
  for (let i = from; i < to; i++) {
    if (notes[i] >= 0) counts.set(notes[i], (counts.get(notes[i]) ?? 0) + 1);
  }
  let note = -1;
  let most = 0;
  for (const [pc, n] of counts) {
    if (n > most) {
      most = n;
      note = pc;
    }
  }
  if (note < 0 || note === label.root || !chordTones(label).includes(note)) return undefined;
  return most >= SLASH_SHARE * (to - from) ? note : undefined;
}

/**
 * Pitch-class weights of a chord timeline: each chord's three notes, by how
 * long it sounds. Free of the overtones in spectral chroma, so it tells
 * neighbouring keys apart better.
 */
export function chordHistogram(chords: ChordSegment[]): Float64Array {
  const weights = new Float64Array(12);
  for (const chord of chords) {
    for (const tone of chordTones(chord)) weights[tone] += chord.end - chord.start;
  }
  return weights;
}

function median(values: Float32Array): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[sorted.length >> 1];
}
