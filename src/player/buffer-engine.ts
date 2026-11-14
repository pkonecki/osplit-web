import type { Stem } from "../types";
import {
  BLOCKED_PLAYBACK_MESSAGE,
  type PlaybackEngine,
  type PlayerTime,
  type StemAudio,
} from "./engine";

/** Lead time so every source can be scheduled before the shared start. */
const START_LEAD_SECONDS = 0.05;

/**
 * Plays decoded stems with one AudioBufferSourceNode each, all started at the
 * same audio-clock time and offset, so they stay aligned to the sample.
 */
export class BufferEngine implements PlaybackEngine {
  readonly kind = "buffer";
  private readonly context: AudioContext;
  private readonly buffers: Map<Stem, AudioBuffer>;
  private readonly gains: Map<Stem, GainNode>;
  private readonly duration: number;
  private sources: AudioBufferSourceNode[] = [];
  /** Playback position when paused, or where the current run started. */
  private offset = 0;
  /** Audio-clock time at which the current run started. */
  private startedAt = 0;
  private playing = false;

  private constructor(context: AudioContext, buffers: Map<Stem, AudioBuffer>) {
    this.context = context;
    this.buffers = buffers;
    this.gains = new Map(
      [...buffers.keys()].map((stem) => {
        const gain = context.createGain();
        gain.connect(context.destination);
        return [stem, gain];
      }),
    );
    this.duration = Math.max(...[...buffers.values()].map((b) => b.duration));
  }

  /** Decodes every stem; FLAC and WAV are both decoded by the browser. */
  static async load(
    context: AudioContext,
    stems: StemAudio[],
  ): Promise<BufferEngine> {
    const decoded = await Promise.all(
      stems.map(async ({ stem, blob }) =>
        [stem, await context.decodeAudioData(await blob.arrayBuffer())] as const
      ),
    );
    return new BufferEngine(context, new Map(decoded));
  }

  time(): PlayerTime {
    const elapsed = this.playing
      ? Math.max(0, this.context.currentTime - this.startedAt)
      : 0;
    return {
      position: Math.min(this.duration, this.offset + elapsed),
      duration: this.duration,
      playing: this.playing,
    };
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (this.offset >= this.duration) this.offset = 0;
    await this.context.resume().catch(() => undefined);
    if (this.context.state !== "running") throw new Error(BLOCKED_PLAYBACK_MESSAGE);
    this.startSources();
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.time().position;
    this.stopSources();
    this.playing = false;
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.duration, seconds));
    if (this.playing) {
      this.stopSources();
      this.offset = target;
      this.startSources();
    } else {
      this.offset = target;
    }
  }

  setGain(stem: Stem, gain: number): void {
    const node = this.gains.get(stem);
    if (node) node.gain.value = gain;
  }

  tick(): void {
    // The end is handled by the sources' ended event.
  }

  release(): void {
    this.stopSources();
    this.playing = false;
    this.gains.forEach((gain) => gain.disconnect());
  }

  private startSources(): void {
    const when = this.context.currentTime + START_LEAD_SECONDS;
    const offset = this.offset;
    this.sources = [...this.buffers].map(([stem, buffer]) => {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gains.get(stem)!);
      source.start(when, offset);
      return source;
    });
    const current = this.sources;
    // All sources end together; the first one's end stops playback at the end.
    current[0].onended = () => {
      if (this.sources !== current) return;
      this.sources = [];
      this.playing = false;
      this.offset = this.duration;
    };
    this.startedAt = when;
    this.playing = true;
  }

  private stopSources(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    this.sources = [];
  }
}
