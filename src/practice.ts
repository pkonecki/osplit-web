import type { Project, ProjectLoop } from "./types";

/**
 * Practice settings: playback speed, key shift and an A–B loop. These pure
 * helpers hold the rules; the player applies them and the views show them.
 */

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 1.5;
/** Step of the speed buttons and shortcuts (the slider moves by 1%). */
export const SPEED_STEP = 0.05;
export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;
/** Shortest loop; a shorter region would be hard to hear or grab. */
export const MIN_LOOP_SECONDS = 0.25;

/** A region of the track, in seconds; `end` is after `start`. */
export interface LoopRegion {
  start: number;
  end: number;
}

export type SavedLoop = ProjectLoop;

/** Speed, rounded to whole percent and kept within MIN_SPEED–MAX_SPEED. */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed)) * 100) / 100;
}

/** Key shift in whole semitones, within MIN_SEMITONES–MAX_SEMITONES. */
export function clampSemitones(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  return Math.round(Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, semitones)));
}

export function projectSpeed(project: Project): number {
  return clampSpeed(project.speed ?? 1);
}

export function projectSemitones(project: Project): number {
  return clampSemitones(project.semitones ?? 0);
}

/** The loop the player should repeat, or null when there is none or it is off. */
export function activeLoop(project: Project): LoopRegion | null {
  const loop = project.loop;
  if (!loop?.enabled || !(loop.end - loop.start >= MIN_LOOP_SECONDS)) return null;
  return { start: loop.start, end: loop.end };
}

/** Whether speed, key and loop are all at their defaults. */
export function isNeutral(project: Project): boolean {
  return projectSpeed(project) === 1 && projectSemitones(project) === 0 &&
    !project.loop;
}

/**
 * A region from two positions in either order, kept inside the track and at
 * least MIN_LOOP_SECONDS long; null if the track is too short for one.
 */
export function normalizeLoop(
  a: number,
  b: number,
  duration: number,
): LoopRegion | null {
  if (!(duration >= MIN_LOOP_SECONDS)) return null;
  const clamp = (value: number) => Math.max(0, Math.min(duration, value));
  let start = clamp(Math.min(a, b));
  let end = clamp(Math.max(a, b));
  if (end - start < MIN_LOOP_SECONDS) {
    end = Math.min(duration, start + MIN_LOOP_SECONDS);
    start = Math.max(0, end - MIN_LOOP_SECONDS);
  }
  return { start: round(start), end: round(end) };
}

/** Moves the loop start to `position`, keeping the end if still after it. */
export function loopWithStart(
  loop: SavedLoop | undefined,
  position: number,
  duration: number,
): SavedLoop | undefined {
  const end = loop && loop.end - position >= MIN_LOOP_SECONDS ? loop.end : duration;
  const region = normalizeLoop(position, end, duration);
  return region ? { ...region, enabled: loop?.enabled ?? false } : loop;
}

/** Moves the loop end to `position` and turns the loop on. */
export function loopWithEnd(
  loop: SavedLoop | undefined,
  position: number,
  duration: number,
): SavedLoop | undefined {
  const start = loop && position - loop.start >= MIN_LOOP_SECONDS ? loop.start : 0;
  const region = normalizeLoop(start, position, duration);
  return region ? { ...region, enabled: true } : loop;
}

/** A loop with one edge moved by `delta` seconds (keyboard on a handle). */
export function nudgeLoopEdge(
  loop: SavedLoop,
  edge: "start" | "end",
  delta: number,
  duration: number,
): SavedLoop {
  const start = edge === "start"
    ? Math.min(loop.start + delta, loop.end - MIN_LOOP_SECONDS)
    : loop.start;
  const end = edge === "end"
    ? Math.max(loop.end + delta, loop.start + MIN_LOOP_SECONDS)
    : loop.end;
  const region = normalizeLoop(start, end, duration);
  return region ? { ...loop, ...region } : loop;
}

/**
 * Where a playhead that started before `loop.end` is after running on to
 * `position`: past the end it wraps back into the loop.
 */
export function wrapPosition(position: number, loop: LoopRegion | null): number {
  if (!loop || position < loop.end) return position;
  const length = loop.end - loop.start;
  if (!(length > 0)) return loop.start;
  return loop.start + ((position - loop.start) % length);
}

/** Where a seek to `seconds` lands: after the end of a loop, at its start. */
export function seekTarget(
  seconds: number,
  duration: number,
  loop: LoopRegion | null,
): number {
  const target = Math.max(0, Math.min(duration, seconds));
  return loop && target >= loop.end ? loop.start : target;
}

/**
 * The pitch shift (semitones) the shared pitch shifter must apply. Decoded
 * buffers change speed by resampling, which also shifts pitch by
 * 12·log2(speed); the shifter corrects that. Streaming <audio> elements keep
 * their pitch themselves (preservesPitch), so only the key shift remains.
 */
export function busTranspose(
  engine: "buffer" | "media",
  speed: number,
  semitones: number,
): number {
  const correction = engine === "buffer" ? -12 * Math.log2(speed) : 0;
  const transpose = semitones + correction;
  return Math.abs(transpose) < 1e-9 ? 0 : transpose;
}

export function formatSpeed(speed: number): string {
  return `${Math.round(speed * 100)}%`;
}

export function formatSemitones(semitones: number): string {
  if (semitones === 0) return "Original";
  return semitones > 0 ? `+${semitones}` : `−${-semitones}`;
}

/** A position with tenths of a second, e.g. "1:02.4". */
export function formatPrecise(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
