import { type LoopRegion, seekTarget } from "../practice";
import type { Stem } from "../types";
import {
  BLOCKED_PLAYBACK_MESSAGE,
  type PlaybackEngine,
  type PlayerTime,
  type StemAudio,
} from "./engine";

/** Stems further than this from the first stem are moved back to it. */
const MAX_DRIFT_SECONDS = 0.03;
/** How often an active loop checks for its end while playing. */
const LOOP_CHECK_MS = 15;
/** Fade around a loop's jump back, which would otherwise click. */
const LOOP_FADE_SECONDS = 0.01;

/**
 * Plays stems with one streaming <audio> element each, routed through Web
 * Audio for the per-stem gain. Uses little memory; elements can drift apart,
 * so each tick moves any stem that drifted back to the first one.
 *
 * Elements change speed themselves, keeping the pitch (preservesPitch). They
 * cannot loop part of a track, so an active loop is checked every few
 * milliseconds and every element is moved back to its start, with a short
 * fade: unlike decoded playback, this leaves a small gap.
 */
export class MediaEngine implements PlaybackEngine {
  readonly kind = "media";
  private readonly context: AudioContext;
  private readonly players = new Map<Stem, HTMLAudioElement>();
  private readonly objectUrls: string[] = [];
  private readonly sources = new Map<Stem, MediaElementAudioSourceNode>();
  private readonly gains = new Map<Stem, GainNode>();
  private readonly wantedGains = new Map<Stem, number>();
  /** Every stem's gain feeds this; it fades out and in around loop jumps. */
  private readonly fader: GainNode;
  private rate = 1;
  private loop: LoopRegion | null = null;
  private loopTimer: number | undefined;
  private wrapping = false;
  private outputDelay = 0;

  constructor(context: AudioContext, stems: StemAudio[], destination: AudioNode) {
    this.context = context;
    this.fader = new GainNode(context);
    this.fader.connect(destination);
    for (const { stem, blob } of stems) {
      const url = URL.createObjectURL(blob);
      // Element volume stays at 1: levels are applied by the Web Audio gain
      // nodes, since mobile browsers ignore `volume` and others would apply
      // it twice.
      const player = new Audio(url);
      player.preload = "auto";
      keepPitch(player);
      player.addEventListener("ended", () => this.onEnded());
      this.players.set(stem, player);
      this.objectUrls.push(url);
    }
  }

  private get reference(): HTMLAudioElement | undefined {
    return this.players.values().next().value;
  }

  time(): PlayerTime {
    const first = this.reference;
    const current = first?.currentTime ?? 0;
    const playing = [...this.players.values()].some((player) => !player.paused);
    const heard = playing ? current - this.outputDelay * this.rate : current;
    return {
      position: Math.max(this.loop && current >= this.loop.start ? this.loop.start : 0, heard),
      duration: Number.isFinite(first?.duration) ? first!.duration : 0,
      playing,
      rate: this.rate,
    };
  }

  async play(): Promise<void> {
    const reference = this.reference;
    if (reference && reference.currentTime >= reference.duration) {
      this.seek(this.loop?.start ?? 0);
    }
    // Media element sources can be created once per element, on first play.
    for (const [stem, player] of this.players) {
      if (this.sources.has(stem)) continue;
      const source = this.context.createMediaElementSource(player);
      const gain = this.context.createGain();
      gain.gain.value = this.wantedGains.get(stem) ?? 1;
      source.connect(gain).connect(this.fader);
      this.sources.set(stem, source);
      this.gains.set(stem, gain);
    }
    const results = await Promise.allSettled([
      this.context.resume(),
      ...[...this.players.values()].map((player) => player.play()),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      this.stopPlayers();
      throw new Error(BLOCKED_PLAYBACK_MESSAGE);
    }
    this.updateLoopTimer();
  }

  pause(): void {
    const heard = this.time();
    this.stopPlayers();
    // Resume from what was heard: audio still inside the pitch shifter when
    // pausing is played again rather than skipped.
    if (heard.playing && this.outputDelay > 0) this.seek(heard.position);
  }

  seek(seconds: number): void {
    const target = seekTarget(seconds, this.duration(), this.loop);
    this.players.forEach((player) => {
      if (Number.isFinite(player.duration)) {
        player.currentTime = Math.min(target, player.duration);
      }
    });
  }

  setGain(stem: Stem, gain: number): void {
    this.wantedGains.set(stem, gain);
    const node = this.gains.get(stem);
    if (node) node.gain.value = gain;
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.players.forEach((player) => {
      player.playbackRate = rate;
    });
  }

  setLoop(loop: LoopRegion | null): void {
    this.loop = loop;
    const reference = this.reference;
    if (loop && reference && reference.currentTime >= loop.end) {
      this.seek(loop.start);
    }
    this.updateLoopTimer();
  }

  setOutputDelay(seconds: number): void {
    this.outputDelay = seconds;
  }

  channels(): null {
    // Streaming playback never holds the decoded track.
    return null;
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
    this.loop = null;
    this.updateLoopTimer();
    this.players.forEach((player) => {
      player.pause();
      player.removeAttribute("src");
      player.load();
    });
    this.sources.forEach((source) => source.disconnect());
    this.gains.forEach((gain) => gain.disconnect());
    this.fader.disconnect();
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.players.clear();
  }

  private duration(): number {
    const duration = this.reference?.duration;
    return Number.isFinite(duration) ? duration! : 0;
  }

  private onEnded(): void {
    // A loop that ends with the track can miss its check at the very end.
    if (this.loop) {
      this.seek(this.loop.start);
      void this.play().catch(() => undefined);
    } else {
      this.stopPlayers();
    }
  }

  private stopPlayers(): void {
    this.players.forEach((player) => player.pause());
    this.updateLoopTimer();
  }

  /** Runs the loop check only while a loop is active and playing. */
  private updateLoopTimer(): void {
    const playing = !(this.reference?.paused ?? true);
    if (this.loop && playing) {
      this.loopTimer ??= window.setInterval(() => this.checkLoop(), LOOP_CHECK_MS);
    } else if (this.loopTimer !== undefined) {
      window.clearInterval(this.loopTimer);
      this.loopTimer = undefined;
    }
  }

  private checkLoop(): void {
    const reference = this.reference;
    const loop = this.loop;
    if (!loop || !reference || reference.paused || this.wrapping) return;
    // Jump slightly early: the check runs every few milliseconds and the
    // fade-out takes LOOP_FADE_SECONDS of playback.
    const early = (LOOP_CHECK_MS / 1000 / 2 + LOOP_FADE_SECONDS) * this.rate;
    if (reference.currentTime < loop.end - early) return;
    this.wrapping = true;
    const gain = this.fader.gain;
    const now = this.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + LOOP_FADE_SECONDS);
    window.setTimeout(() => {
      if (this.loop) this.seek(this.loop.start);
      const at = this.context.currentTime;
      gain.cancelScheduledValues(at);
      gain.setValueAtTime(0, at);
      gain.linearRampToValueAtTime(1, at + LOOP_FADE_SECONDS * 2);
      this.wrapping = false;
    }, LOOP_FADE_SECONDS * 1000);
  }
}

/** Keeps the pitch when the speed changes (prefixed in older WebKit). */
function keepPitch(player: HTMLAudioElement): void {
  player.preservesPitch = true;
  (player as HTMLAudioElement & { webkitPreservesPitch?: boolean })
    .webkitPreservesPitch = true;
}
