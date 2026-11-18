import { beatsTempo, trackBeats } from "./beats";
import { type BeatsPerBar, estimateMetre } from "./downbeats";
import { onsetEnvelopes } from "./onset";
import { bpmToLag, estimateTempo } from "./tempo";

/**
 * The rhythm analysis pipeline: onset strength, global tempo, beats, then
 * metre and downbeats. Pure, so it runs in the analysis worker and in tests.
 */

/** Below this tempo confidence, no beats are reported (tap tempo remains). */
export const NO_BEAT_CONFIDENCE = 0.1;

/** Mono signals at ANALYSIS_RATE. */
export interface RhythmInput {
  /** Drives the beats: the drum stem, or every stem summed. */
  source: Float32Array;
  sourceName: "drums" | "mix";
  /** Bass stem, for downbeats. */
  bass?: Float32Array;
}

export interface RhythmResult {
  source: "drums" | "mix";
  bpm: number;
  bpmConfidence: number;
  /** The other likely octave of the tempo, if any. */
  alternativeBpm: number | null;
  /** Beat times, seconds. */
  beats: Float32Array;
  beatsPerBar: BeatsPerBar;
  firstDownbeatIndex: number;
}

export function analyzeRhythm(
  input: RhythmInput,
  progress: (stage: string, fraction: number) => void = () => {},
): RhythmResult {
  progress("Finding onsets", 0);
  const source = onsetEnvelopes(input.source);
  const low = input.bass ? onsetEnvelopes(input.bass).low : undefined;
  // Separation often splits the kick between the drum and bass stems: the
  // bass stem's attacks (kick, and bass notes, mostly on beats) count too.
  const envelope = Float32Array.from(source.full, (value, i) => value + 0.5 * (low?.[i] ?? 0));
  progress("Estimating tempo", 0.4);
  const tempo = estimateTempo(envelope);
  progress("Tracking beats", 0.6);
  // Without a pulse to speak of, any grid would mislead: report none.
  const beats = tempo.confidence < NO_BEAT_CONFIDENCE
    ? new Float64Array()
    : trackBeats(envelope, bpmToLag(tempo.bpm));
  progress("Finding downbeats", 0.9);
  const strength = new Float32Array(source.low.length);
  for (let i = 0; i < strength.length; i++) {
    strength[i] = source.low[i] + (low?.[i] ?? 0);
  }
  const metre = estimateMetre(beats, strength);
  const bpm = beatsTempo(beats) ?? tempo.bpm;
  return {
    source: input.sourceName,
    bpm,
    bpmConfidence: beats.length >= 4 ? tempo.confidence : 0,
    alternativeBpm: tempo.alternative,
    beats: Float32Array.from(beats),
    beatsPerBar: metre.beatsPerBar,
    firstDownbeatIndex: metre.firstDownbeat,
  };
}
