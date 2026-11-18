import type { LoopRegion } from "../practice";
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
  /** Playback speed (1 = original). */
  rate: number;
}

/**
 * A way of playing all stems together, each through its own gain. The gains
 * feed the `destination` node given to the engine; the player routes it to
 * the speakers, through the pitch shifter when one is needed.
 */
export interface PlaybackEngine {
  readonly kind: "buffer" | "media";
  /** Position heard now, allowing for the output delay. */
  time(): PlayerTime;
  play(): Promise<void>;
  pause(): void;
  /** Moves to `seconds`; after the end of an active loop, to its start. */
  seek(seconds: number): void;
  setGain(stem: Stem, gain: number): void;
  /** Playback speed, 0.5–1.5. */
  setRate(rate: number): void;
  /** Repeats `loop` (track seconds) seamlessly, or plays through when null. */
  setLoop(loop: LoopRegion | null): void;
  /**
   * Delay (seconds) between the engine's output and the speakers, such as
   * the pitch shifter's latency: the position shown, and where a pause
   * resumes, are what is heard rather than what was sent.
   */
  setOutputDelay(seconds: number): void;
  /** A stem's decoded left and right channels, when the engine has them. */
  channels(stem: Stem): [Float32Array, Float32Array] | null;
  /** Called every 250 ms while the project page is open. */
  tick(): void;
  release(): void;
}

export const BLOCKED_PLAYBACK_MESSAGE =
  "The browser blocked synchronized playback. Tap Play again to allow audio, or check Brave's autoplay/site audio settings.";
