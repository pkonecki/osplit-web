import { getStem } from "./storage";
import { type Project, type Stem, STEM_LABELS } from "./types";

/**
 * The project player: one <audio> element per stem, played together through
 * Web Audio, with a gain node per stem for its level.
 */

let playerProjectId: string | null = null;
const players = new Map<Stem, HTMLAudioElement>();
const objectUrls = new Map<Stem, string>();
const mediaSources = new Map<Stem, MediaElementAudioSourceNode>();
const stemGains = new Map<Stem, GainNode>();
let playbackContext: AudioContext | undefined;
let progressTimer: number | undefined;
let onTick: () => void = () => {};

/** Sets what runs on every player clock tick and seek (the time display). */
export function setPlayerTick(tick: () => void): void {
  onTick = tick;
}

export function playerTime(): {
  position: number;
  duration: number;
  playing: boolean;
} {
  const first = players.values().next().value as HTMLAudioElement | undefined;
  return {
    position: first?.currentTime ?? 0,
    duration: Number.isFinite(first?.duration) ? first!.duration : 0,
    playing: isPlaying(),
  };
}

export function isPlaying(): boolean {
  return [...players.values()].some((player) => !player.paused);
}

export async function preparePlayers(project: Project): Promise<void> {
  if (!project.completedStems.length || playerProjectId === project.id) return;
  releasePlayers();
  const entries = await Promise.all(project.completedStems.map(async (stem) => {
    const stored = await getStem(project.id, stem);
    if (!stored) {
      throw new Error(`The saved ${STEM_LABELS[stem]} audio is missing.`);
    }
    const url = URL.createObjectURL(stored.blob);
    // Element volume stays at 1: levels are applied by the Web Audio gain nodes,
    // since mobile browsers ignore `volume` and others would apply it twice.
    const player = new Audio(url);
    player.preload = "auto";
    player.addEventListener("ended", () => pauseAll());
    players.set(stem, player);
    objectUrls.set(stem, url);
    return player;
  }));
  playerProjectId = project.id;
  if (entries.length) {
    progressTimer = window.setInterval(() => onTick(), 250);
  }
}

export function releasePlayers(): void {
  if (progressTimer !== undefined) window.clearInterval(progressTimer);
  progressTimer = undefined;
  players.forEach((player) => {
    player.pause();
    player.removeAttribute("src");
    player.load();
  });
  mediaSources.forEach((source) => source.disconnect());
  stemGains.forEach((gain) => gain.disconnect());
  mediaSources.clear();
  stemGains.clear();
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  players.clear();
  objectUrls.clear();
  playerProjectId = null;
}

export async function pauseAll(): Promise<void> {
  players.forEach((player) => player.pause());
}

export function stemVolume(project: Project, stem: Stem): number {
  return project.mutedStems.includes(stem) ? 0 : project.volumes[stem];
}

export function applyStemVolume(project: Project, stem: Stem): void {
  const gain = stemGains.get(stem);
  if (gain) gain.gain.value = stemVolume(project, stem);
}

export async function playAll(project: Project): Promise<void> {
  if (!players.size) {
    throw new Error("Separate stems before using the project player.");
  }
  if (![...players.keys()].some((stem) => stemVolume(project, stem) > 0)) {
    throw new Error("Unmute at least one stem before playing.");
  }
  const reference = players.values().next().value as HTMLAudioElement;
  if (reference.currentTime >= reference.duration) {
    players.forEach((player) => {
      player.currentTime = 0;
    });
  }
  const context = playbackContext ??= new AudioContext();
  for (const [stem, player] of players) {
    if (mediaSources.has(stem)) continue;
    const source = context.createMediaElementSource(player);
    const gain = context.createGain();
    gain.gain.value = stemVolume(project, stem);
    source.connect(gain).connect(context.destination);
    mediaSources.set(stem, source);
    stemGains.set(stem, gain);
  }

  const resume = context.resume();
  const startResults = await Promise.allSettled([
    resume,
    ...[...players.values()].map((player) => player.play()),
  ]);
  const failed = startResults.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    await pauseAll();
    throw new Error(
      "The browser blocked synchronized playback. Tap Play again to allow audio, or check Brave's autoplay/site audio settings.",
    );
  }
}

export function seekAll(seconds: number): void {
  players.forEach((player) => {
    if (Number.isFinite(player.duration)) {
      player.currentTime = Math.min(seconds, player.duration);
    }
  });
  onTick();
}
