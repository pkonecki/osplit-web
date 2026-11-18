import { stemFrameCount } from "./audio-format";
import { stemVolume } from "./mixing";
import { playbackEngineFor } from "./memory";
import { BufferEngine } from "./player/buffer-engine";
import type { PlaybackEngine, PlayerTime, StemAudio } from "./player/engine";
import { MediaEngine } from "./player/media-engine";
import { stopMediaSession } from "./player/media-session";
import {
  createPitchShifter,
  PITCH_SHIFT_UNAVAILABLE,
  type PitchShifter,
} from "./player/pitch-shifter";
import { activeLoop, busTranspose, projectSemitones, projectSpeed } from "./practice";
import { getStem } from "./storage";
import { type Project, type Stem, STEM_LABELS } from "./types";

/**
 * The project player. Stems play through one gain node each, from decoded
 * buffers started together (sample-accurate) or, when the decoded track
 * would not fit the device's memory, from streaming <audio> elements kept in
 * sync by drift correction.
 *
 * The stem gains meet on a shared bus. At the original speed and key the bus
 * goes straight to the speakers; otherwise it goes through the pitch shifter
 * (loaded on first use), which corrects the pitch change of a speed change
 * and applies the key shift.
 */

let engine: PlaybackEngine | null = null;
let playerProjectId: string | null = null;
/** Increases on every load or release, so a superseded load is discarded. */
let loadToken = 0;
let loading = false;
let audioContext: AudioContext | undefined;
/** Where every stem gain goes; routed to the speakers by `routeBus`. */
let bus: GainNode | undefined;
let shifter: Promise<PitchShifter> | undefined;
/** The shifter now in the signal path, if any. */
let routedShifter: PitchShifter | null = null;
/** Increases on every routing, so a superseded one (still loading) is dropped. */
let routeToken = 0;
let progressTimer: number | undefined;
let onTick: () => void = () => {};
let onLoaded: (project: Project) => void = () => {};

/** Sets what runs on every player clock tick and seek (the time display). */
export function setPlayerTick(tick: () => void): void {
  onTick = tick;
}

/** Sets what runs once a project's stems are ready to play. */
export function setPlayerLoaded(loaded: (project: Project) => void): void {
  onLoaded = loaded;
}

/** A stem's decoded channels, when the player holds them (buffer engine). */
export function decodedChannels(
  stem: Stem,
): [Float32Array, Float32Array] | null {
  return engine?.channels(stem) ?? null;
}

/** Position, duration and state; `ready` is false while stems are loading. */
export function playerTime(): PlayerTime & { ready: boolean } {
  const time = engine?.time() ??
    { position: 0, duration: 0, playing: false, rate: 1 };
  return { ...time, ready: engine !== null };
}

/** Which engine plays the current project, or null before it is ready. */
export function playerEngineKind(): PlaybackEngine["kind"] | null {
  return engine?.kind ?? null;
}

export function isPlaying(): boolean {
  return engine?.time().playing ?? false;
}

export async function preparePlayers(project: Project): Promise<void> {
  if (!project.completedStems.length || playerProjectId === project.id) return;
  releasePlayers();
  playerProjectId = project.id;
  const token = ++loadToken;
  loading = true;
  onTick();
  try {
    const stems: StemAudio[] = await Promise.all(
      project.completedStems.map(async (stem) => {
        const stored = await getStem(project.id, stem);
        if (!stored) {
          throw new Error(`The saved ${STEM_LABELS[stem]} audio is missing.`);
        }
        return { stem, blob: stored.blob };
      }),
    );
    const context = audioContext ??= new AudioContext();
    if (!bus) {
      bus = new GainNode(context);
      bus.connect(context.destination);
    }
    const kind = playbackEngineFor(
      await stemFrameCount(stems[0].blob),
      stems.length,
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    );
    let next: PlaybackEngine;
    if (kind === "buffer") {
      try {
        next = await BufferEngine.load(context, stems, bus);
      } catch (error) {
        console.warn("Could not decode the stems; using streaming playback.", error);
        next = new MediaEngine(context, stems, bus);
      }
    } else {
      next = new MediaEngine(context, stems, bus);
    }
    if (token !== loadToken) {
      next.release();
      return;
    }
    engine = next;
    for (const stem of project.completedStems) {
      engine.setGain(stem, stemVolume(project, stem));
    }
    const practice = applyPractice(project);
    progressTimer = window.setInterval(() => {
      engine?.tick();
      onTick();
    }, 250);
    onLoaded(project);
    await practice;
  } finally {
    if (token === loadToken) {
      loading = false;
      onTick();
    }
  }
}

export function releasePlayers(): void {
  if (progressTimer !== undefined) window.clearInterval(progressTimer);
  progressTimer = undefined;
  engine?.release();
  engine = null;
  routeToken++;
  playerProjectId = null;
  loading = false;
  loadToken++;
  stopMediaSession();
}

export async function pauseAll(): Promise<void> {
  engine?.pause();
}

export { stemVolume };

export function applyStemVolume(project: Project, stem: Stem): void {
  engine?.setGain(stem, stemVolume(project, stem));
}

export async function playAll(project: Project): Promise<void> {
  if (!engine) {
    throw new Error(
      loading
        ? "The player is still loading the stems."
        : "Separate stems before using the project player.",
    );
  }
  if (!project.completedStems.some((stem) => stemVolume(project, stem) > 0)) {
    throw new Error("Unmute at least one stem before playing.");
  }
  for (const stem of project.completedStems) {
    engine.setGain(stem, stemVolume(project, stem));
  }
  await engine.play();
}

export function seekAll(seconds: number): void {
  engine?.seek(seconds);
  onTick();
}

/**
 * Applies the project's speed, key and loop to the player. Speed and loop
 * apply at once; the pitch shifter may need loading first. Rejects with a
 * message when the shifter is unavailable; playback then continues at the
 * original speed and key.
 */
export async function applyPractice(project: Project): Promise<void> {
  const current = engine;
  if (!current) return;
  const speed = projectSpeed(project);
  current.setRate(speed);
  current.setLoop(activeLoop(project));
  const transpose = busTranspose(current.kind, speed, projectSemitones(project));
  const token = ++routeToken;
  if (transpose === 0) {
    routeBus(null);
    current.setOutputDelay(0);
    return;
  }
  let next: PitchShifter;
  try {
    next = await (shifter ??= createPitchShifter(audioContext!));
  } catch (error) {
    shifter = undefined;
    console.warn("The pitch shifter could not be loaded.", error);
    if (token === routeToken && engine === current) {
      current.setRate(1);
      routeBus(null);
      current.setOutputDelay(0);
    }
    throw new Error(PITCH_SHIFT_UNAVAILABLE);
  }
  if (token !== routeToken || engine !== current) return;
  void next.setSemitones(transpose);
  routeBus(next);
  current.setOutputDelay(next.latency);
}

/** Sends the bus to the speakers directly, or through `next`. */
function routeBus(next: PitchShifter | null): void {
  if (!bus || !audioContext || next === routedShifter) return;
  bus.disconnect();
  routedShifter?.node.disconnect();
  if (next) {
    bus.connect(next.node);
    next.node.connect(audioContext.destination);
  } else {
    bus.connect(audioContext.destination);
  }
  routedShifter = next;
}

/** Whether audio is going through the pitch shifter (for tests and display). */
export function pitchShifterActive(): boolean {
  return routedShifter !== null;
}
