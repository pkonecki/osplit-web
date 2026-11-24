import type { BeatGrid } from "./grid";
import { isDownbeat } from "./grid";

/**
 * Click sounds and the click track: a short decaying sine, higher on
 * downbeats. The same samples play live and go into exports.
 */

const ACCENT_HZ = 1500;
const BEAT_HZ = 1000;
const CLICK_SECONDS = 0.03;
const CLICK_LEVEL = 0.6;

/** A click's sound: accented (bar start), a beat, or a subdivision between beats. */
export type ClickKind = "accent" | "beat" | "sub";

/** How the click plays: accent on bar starts, and clicks between beats. */
export interface ClickOptions {
  accent: boolean;
  subdivision: number;
}

export const DEFAULT_CLICK_OPTIONS: ClickOptions = { accent: true, subdivision: 1 };

export function clickSamples(kind: ClickKind | boolean, rate: number): Float32Array {
  const type: ClickKind = kind === true ? "accent" : kind === false ? "beat" : kind;
  const length = Math.round(CLICK_SECONDS * rate);
  const frequency = type === "accent" ? ACCENT_HZ : BEAT_HZ;
  const level = type === "accent" ? CLICK_LEVEL : type === "beat" ? CLICK_LEVEL * 0.7 : CLICK_LEVEL * 0.35;
  const samples = new Float32Array(length);
  // A 1 ms attack avoids a click of its own at the start.
  const attack = Math.round(0.001 * rate);
  for (let i = 0; i < length; i++) {
    const envelope = Math.min(1, i / attack) * Math.exp(-i / (0.006 * rate));
    samples[i] = level * envelope * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return samples;
}

/** Part of the track a click render covers, and how fast it plays. */
export interface ClickRegion {
  start: number;
  end: number;
  speed: number;
}

/**
 * The click track (mono) for `region` of the track at `speed`: `frames`
 * samples at `rate`, each beat's click placed where the beat is heard.
 */
export function renderClickTrack(
  grid: BeatGrid,
  region: ClickRegion,
  rate: number,
  frames: number,
  options: ClickOptions = DEFAULT_CLICK_OPTIONS,
): Float32Array {
  const output = new Float32Array(frames);
  const sounds: Record<ClickKind, Float32Array> = {
    accent: clickSamples("accent", rate),
    beat: clickSamples("beat", rate),
    sub: clickSamples("sub", rate),
  };
  const place = (time: number, kind: ClickKind) => {
    if (time < region.start || time >= region.end) return;
    const at = Math.round(((time - region.start) / region.speed) * rate);
    const samples = sounds[kind];
    for (let i = 0; i < samples.length && at + i < frames; i++) output[at + i] += samples[i];
  };
  grid.beats.forEach((time, index) => {
    place(time, beatKind(grid, index, options));
    const next = grid.beats[index + 1] ?? time + 60 / grid.bpm;
    for (let part = 1; part < options.subdivision; part++) {
      place(time + ((next - time) * part) / options.subdivision, "sub");
    }
  });
  return output;
}

/** The sound of beat `index`: accented on bar starts when the accent is on. */
export function beatKind(grid: BeatGrid, index: number, options: ClickOptions): ClickKind {
  return options.accent && isDownbeat(grid, index) ? "accent" : "beat";
}

/**
 * The count-in: `bars` bars of clicks at the grid's metre, a beat every
 * `beatSeconds` (audio-clock seconds, after the speed), from `start`.
 */
export function countInClicks(
  beatsPerBar: number,
  beatSeconds: number,
  bars: number,
  start: number,
  options: ClickOptions,
): { when: number; kind: ClickKind }[] {
  const clicks: { when: number; kind: ClickKind }[] = [];
  for (let beat = 0; beat < bars * beatsPerBar; beat++) {
    const when = start + beat * beatSeconds;
    clicks.push({ when, kind: options.accent && beat % beatsPerBar === 0 ? "accent" : "beat" });
    for (let part = 1; part < options.subdivision; part++) {
      clicks.push({ when: when + (beatSeconds * part) / options.subdivision, kind: "sub" });
    }
  }
  return clicks;
}
