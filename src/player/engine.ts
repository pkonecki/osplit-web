import type { Stem } from "../types";

/** One stem to play: its name and stored audio (FLAC or WAV). */
export interface StemAudio {
  stem: Stem;
  blob: Blob;
}

export interface PlayerTime {
  position: number;
  duration: number;
  playing: boolean;
}

/** A way of playing all stems together, each through its own gain. */
export interface PlaybackEngine {
  readonly kind: "buffer" | "media";
  time(): PlayerTime;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setGain(stem: Stem, gain: number): void;
  /** A stem's decoded left and right channels, when the engine has them. */
  channels(stem: Stem): [Float32Array, Float32Array] | null;
  /** Called every 250 ms while the project page is open. */
  tick(): void;
  release(): void;
}

export const BLOCKED_PLAYBACK_MESSAGE =
  "The browser blocked synchronized playback. Tap Play again to allow audio, or check Brave's autoplay/site audio settings.";
