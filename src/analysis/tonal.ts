import type { ChordSegment, KeyEstimate, Modulation } from "../types";
import {
  BASS_CHROMA_WINDOW,
  BASS_RANGE,
  chromagram,
  FALLBACK_SEGMENT_SECONDS,
  segmentBoundaries,
  segmentChroma,
} from "./chroma";
import { chordHistogram, detectChords, SELF_TRANSITION, SELF_TRANSITION_NO_BEATS } from "./chords";
import { estimateKey, findModulations, sumChroma } from "./key";
import { ANALYSIS_RATE, rms } from "./onset";
import { estimateTuning } from "./tuning";

/**
 * The tonal analysis pipeline: tuning, beat-synchronous chroma, key, then
 * chords. Pure, so it runs in the analysis worker and in tests. The harmonic
 * input leaves the drums out: percussion is the main source of noise in
 * chroma, and having stems makes that easy.
 */

/** Mono signals at ANALYSIS_RATE. */
export interface TonalInput {
  /** Bass, piano and other stems, with the vocals quieter. */
  harmonic: Float32Array;
  /** Bass stem, for chord roots and inversions. */
  bass?: Float32Array;
  /** Beat times (seconds), empty when no beat was found. */
  beats: ArrayLike<number>;
  beatsPerBar: number;
}

export interface TonalResult {
  tuningCents: number;
  key: KeyEstimate | null;
  modulations?: Modulation[];
  chords: ChordSegment[];
}

/** Weight of the vocal stem in the harmonic input. */
export const VOCALS_WEIGHT = 0.3;
/** Below this level the harmonic input counts as silent. */
const SILENT_RMS = 1e-4;
/** A key change counts once held this many bars (or seconds, without beats). */
const MODULATION_BARS = 16;
const MODULATION_SECONDS = 30;

export function analyzeTonal(
  input: TonalInput,
  progress: (stage: string, fraction: number) => void = () => {},
): TonalResult {
  const duration = input.harmonic.length / ANALYSIS_RATE;
  if (!(rms(input.harmonic) > SILENT_RMS)) {
    return { tuningCents: 0, key: null, chords: [] };
  }
  progress("Estimating tuning", 0);
  const tuningCents = estimateTuning(input.harmonic);
  progress("Computing chroma", 0.15);
  const boundaries = segmentBoundaries(input.beats, duration);
  const harmonic = segmentChroma(chromagram(input.harmonic, { tuningCents }), boundaries);
  progress("Finding the key", 0.6);
  const bass = input.bass && rms(input.bass) > SILENT_RMS
    ? segmentChroma(
      chromagram(input.bass, { tuningCents, window: BASS_CHROMA_WINDOW, range: BASS_RANGE }),
      boundaries,
    )
    : undefined;
  // The key from the chords (found without a key first) and the chroma.
  const chordInput = {
    vectors: harmonic.vectors,
    energy: harmonic.energy,
    bass: bass?.vectors,
    bassEnergy: bass?.energy,
    boundaries,
    selfTransition: input.beats.length >= 4 ? SELF_TRANSITION : SELF_TRANSITION_NO_BEATS,
  };
  const key = estimateKey(blend(
    chordHistogram(detectChords({ ...chordInput, key: null })),
    sumChroma(harmonic.vectors, harmonic.energy),
  ));
  const hasBeats = input.beats.length >= 4;
  const segmentSeconds = hasBeats ? duration / Math.max(1, harmonic.count) : FALLBACK_SEGMENT_SECONDS;
  const minSegments = hasBeats
    ? MODULATION_BARS * input.beatsPerBar
    : Math.round(MODULATION_SECONDS / segmentSeconds);
  const modulations = findModulations(
    harmonic.vectors,
    harmonic.energy,
    boundaries,
    Math.round(30 / segmentSeconds),
    minSegments,
  );
  progress("Finding chords", 0.85);
  const chords = detectChords({ ...chordInput, key });
  const result: TonalResult = { tuningCents, key, chords };
  if (modulations) result.modulations = modulations;
  return result;
}

/** Sum of two pitch-class weightings, each scaled to unit length; the second counts half. */
function blend(primary: Float64Array, secondary: Float64Array): Float64Array {
  const norm = (values: Float64Array) => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  const a = norm(primary);
  const b = norm(secondary);
  return primary.map((value, i) => value / a + (0.5 * secondary[i]) / b);
}
