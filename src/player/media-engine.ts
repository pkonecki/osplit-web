import type { Stem } from "../types";
import {
  BLOCKED_PLAYBACK_MESSAGE,
  type PlaybackEngine,
  type PlayerTime,
  type StemAudio,
} from "./engine";

/** Stems further than this from the first stem are moved back to it. */
const MAX_DRIFT_SECONDS = 0.03;

/**
 * Plays stems with one streaming <audio> element each, routed through Web
 * Audio for the per-stem gain. Uses little memory; elements can drift apart,
 * so each tick moves any stem that drifted back to the first one.
 */
export class MediaEngine implements PlaybackEngine {
  readonly kind = "media";
  private readonly context: AudioContext;
  private readonly players = new Map<Stem, HTMLAudioElement>();
  private readonly objectUrls: string[] = [];
  private readonly sources = new Map<Stem, MediaElementAudioSourceNode>();
  private readonly gains = new Map<Stem, GainNode>();
  private readonly wantedGains = new Map<Stem, number>();

  constructor(context: AudioContext, stems: StemAudio[]) {
    this.context = context;
    for (const { stem, blob } of stems) {
      const url = URL.createObjectURL(blob);
      // Element volume stays at 1: levels are applied by the Web Audio gain
      // nodes, since mobile browsers ignore `volume` and others would apply
      // it twice.
      const player = new Audio(url);
      player.preload = "auto";
      player.addEventListener("ended", () => this.pause());
      this.players.set(stem, player);
      this.objectUrls.push(url);
    }
  }

  private get reference(): HTMLAudioElement | undefined {
    return this.players.values().next().value;
  }

  time(): PlayerTime {
    const first = this.reference;
    return {
      position: first?.currentTime ?? 0,
      duration: Number.isFinite(first?.duration) ? first!.duration : 0,
      playing: [...this.players.values()].some((player) => !player.paused),
    };
  }

  async play(): Promise<void> {
    const reference = this.reference;
    if (reference && reference.currentTime >= reference.duration) {
      this.players.forEach((player) => {
        player.currentTime = 0;
      });
    }
    // Media element sources can be created once per element, on first play.
    for (const [stem, player] of this.players) {
      if (this.sources.has(stem)) continue;
      const source = this.context.createMediaElementSource(player);
      const gain = this.context.createGain();
      gain.gain.value = this.wantedGains.get(stem) ?? 1;
      source.connect(gain).connect(this.context.destination);
      this.sources.set(stem, source);
      this.gains.set(stem, gain);
    }
    const results = await Promise.allSettled([
      this.context.resume(),
      ...[...this.players.values()].map((player) => player.play()),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      this.pause();
      throw new Error(BLOCKED_PLAYBACK_MESSAGE);
    }
  }

  pause(): void {
    this.players.forEach((player) => player.pause());
  }

  seek(seconds: number): void {
    this.players.forEach((player) => {
      if (Number.isFinite(player.duration)) {
        player.currentTime = Math.min(seconds, player.duration);
      }
    });
  }

  setGain(stem: Stem, gain: number): void {
    this.wantedGains.set(stem, gain);
    const node = this.gains.get(stem);
    if (node) node.gain.value = gain;
  }

  tick(): void {
    const reference = this.reference;
    if (!reference || reference.paused || reference.seeking) return;
    for (const player of this.players.values()) {
      if (player === reference || player.seeking) continue;
      if (Math.abs(player.currentTime - reference.currentTime) > MAX_DRIFT_SECONDS) {
        player.currentTime = reference.currentTime;
      }
    }
  }

  release(): void {
    this.players.forEach((player) => {
      player.pause();
      player.removeAttribute("src");
      player.load();
    });
    this.sources.forEach((source) => source.disconnect());
    this.gains.forEach((gain) => gain.disconnect());
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.players.clear();
  }
}
