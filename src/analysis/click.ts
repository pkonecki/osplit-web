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

export function clickSamples(accent: boolean, rate: number): Float32Array {
  const length = Math.round(CLICK_SECONDS * rate);
  const frequency = accent ? ACCENT_HZ : BEAT_HZ;
  const level = accent ? CLICK_LEVEL : CLICK_LEVEL * 0.7;
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
): Float32Array {
  const output = new Float32Array(frames);
  const accent = clickSamples(true, rate);
  const normal = clickSamples(false, rate);
  grid.beats.forEach((time, index) => {
    if (time < region.start || time >= region.end) return;
    const at = Math.round(((time - region.start) / region.speed) * rate);
    const samples = isDownbeat(grid, index) ? accent : normal;
    for (let i = 0; i < samples.length && at + i < frames; i++) {
      output[at + i] += samples[i];
    }
  });
  return output;
}
