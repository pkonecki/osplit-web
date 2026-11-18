import { ANALYSIS_RATE } from "./onset";

/**
 * Synthetic rhythm signals for the analysis tests (no recorded audio in the
 * repository): a snare-like noise burst on every beat, a kick on downbeats,
 * optional softer hits between beats, over quiet noise.
 */

export interface PatternOptions {
  seconds: number;
  /** Tempo at the start; with `endBpm`, the tempo changes linearly. */
  bpm: number;
  endBpm?: number;
  beatsPerBar?: number;
  /** Beat index of the first downbeat. */
  firstDownbeat?: number;
  /** Adds a hit halfway between beats, this loud relative to a beat. */
  offbeat?: number;
  /** Seconds before the first beat. */
  start?: number;
}

export interface Pattern {
  /** All instruments (drums). */
  drums: Float32Array;
  /** The kick and a bass note on each downbeat. */
  bass: Float32Array;
  beats: number[];
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function beatTimes(options: PatternOptions): number[] {
  const { seconds, bpm, endBpm = bpm, start = 0.5 } = options;
  const times: number[] = [];
  let time = start;
  while (time < seconds - 0.2) {
    times.push(time);
    // Tempo at this point of the track, changing linearly over its length.
    const now = bpm + ((endBpm - bpm) * time) / seconds;
    time += 60 / now;
  }
  return times;
}

export function pattern(options: PatternOptions, seed = 1): Pattern {
  const random = seededRandom(seed);
  const length = Math.round(options.seconds * ANALYSIS_RATE);
  const drums = new Float32Array(length);
  const bass = new Float32Array(length);
  for (let i = 0; i < length; i++) drums[i] = (random() - 0.5) * 0.01;
  const beats = beatTimes(options);
  const beatsPerBar = options.beatsPerBar ?? 4;
  const firstDownbeat = options.firstDownbeat ?? 0;
  beats.forEach((time, index) => {
    const downbeat = (index - firstDownbeat) % beatsPerBar === 0 &&
      index >= firstDownbeat;
    addNoiseBurst(drums, time, 0.5, random);
    if (downbeat) {
      addTone(drums, time, 55, 0.12, 0.8);
      addTone(bass, time, 55, 0.3, 0.6);
    }
    if (options.offbeat) {
      const next = beats[index + 1] ?? time + (time - (beats[index - 1] ?? 0));
      addNoiseBurst(drums, (time + next) / 2, 0.5 * options.offbeat, random);
    }
  });
  return { drums, bass, beats };
}

function addNoiseBurst(
  signal: Float32Array,
  time: number,
  amplitude: number,
  random: () => number,
): void {
  const start = Math.round(time * ANALYSIS_RATE);
  const length = Math.round(0.04 * ANALYSIS_RATE);
  for (let i = 0; i < length && start + i < signal.length; i++) {
    signal[start + i] += amplitude * (random() * 2 - 1) *
      Math.exp(-i / (0.008 * ANALYSIS_RATE));
  }
}

function addTone(
  signal: Float32Array,
  time: number,
  frequency: number,
  seconds: number,
  amplitude: number,
): void {
  const start = Math.round(time * ANALYSIS_RATE);
  const length = Math.round(seconds * ANALYSIS_RATE);
  for (let i = 0; i < length && start + i < signal.length; i++) {
    signal[start + i] += amplitude * Math.sin((2 * Math.PI * frequency * i) / ANALYSIS_RATE) *
      Math.exp(-i / (seconds * 0.3 * ANALYSIS_RATE));
  }
}

/** Beat F-measure: detected beats matched one-to-one within `tolerance`. */
export function fMeasure(
  detected: ArrayLike<number>,
  truth: number[],
  tolerance = 0.07,
): number {
  const used = new Set<number>();
  let hits = 0;
  for (let i = 0; i < detected.length; i++) {
    let best = -1;
    let bestError = tolerance;
    truth.forEach((time, index) => {
      const error = Math.abs(time - detected[i]);
      if (!used.has(index) && error <= bestError) {
        best = index;
        bestError = error;
      }
    });
    if (best >= 0) {
      used.add(best);
      hits++;
    }
  }
  if (hits === 0) return 0;
  const precision = hits / detected.length;
  const recall = hits / truth.length;
  return (2 * precision * recall) / (precision + recall);
}
