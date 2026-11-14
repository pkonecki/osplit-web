import { stemFrameCount } from "./audio-format";
import { stemVolume } from "./mixing";
import { playbackEngineFor } from "./memory";
import { BufferEngine } from "./player/buffer-engine";
import type { PlaybackEngine, PlayerTime, StemAudio } from "./player/engine";
import { MediaEngine } from "./player/media-engine";
import { stopMediaSession } from "./player/media-session";
import { getStem } from "./storage";
import { type Project, type Stem, STEM_LABELS } from "./types";

/**
 * The project player. Stems play through one gain node each, from decoded
 * buffers started together (sample-accurate) or, when the decoded track
 * would not fit the device's memory, from streaming <audio> elements kept in
 * sync by drift correction.
 */

let engine: PlaybackEngine | null = null;
let playerProjectId: string | null = null;
/** Increases on every load or release, so a superseded load is discarded. */
let loadToken = 0;
let loading = false;
let audioContext: AudioContext | undefined;
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
  const time = engine?.time() ?? { position: 0, duration: 0, playing: false };
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
    const kind = playbackEngineFor(
      await stemFrameCount(stems[0].blob),
      stems.length,
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    );
    let next: PlaybackEngine;
    if (kind === "buffer") {
      try {
        next = await BufferEngine.load(context, stems);
      } catch (error) {
        console.warn("Could not decode the stems; using streaming playback.", error);
        next = new MediaEngine(context, stems);
      }
    } else {
      next = new MediaEngine(context, stems);
    }
    if (token !== loadToken) {
      next.release();
      return;
    }
    engine = next;
    for (const stem of project.completedStems) {
      engine.setGain(stem, stemVolume(project, stem));
    }
    progressTimer = window.setInterval(() => {
      engine?.tick();
      onTick();
    }, 250);
    onLoaded(project);
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
