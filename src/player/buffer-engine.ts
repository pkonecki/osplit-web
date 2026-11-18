import { type LoopRegion, seekTarget } from "../practice";
import type { Stem } from "../types";
import { PlaybackClock } from "./clock";
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
 * same audio-clock time and offset, so they stay aligned to the sample. Speed
 * is each source's playbackRate (which also shifts the pitch; the player's
 * pitch shifter corrects it), and loops use the sources' native looping, so
 * every stem wraps at the same sample without a gap.
 */
export class BufferEngine implements PlaybackEngine {
  readonly kind = "buffer";
  private readonly context: AudioContext;
  private readonly buffers: Map<Stem, AudioBuffer>;
  private readonly gains: Map<Stem, GainNode>;
  private readonly duration: number;
  private readonly clock: PlaybackClock;
  private sources: AudioBufferSourceNode[] = [];
  private rate = 1;
  private loop: LoopRegion | null = null;
  private outputDelay = 0;

  private constructor(
    context: AudioContext,
    buffers: Map<Stem, AudioBuffer>,
    destination: AudioNode,
  ) {
    this.context = context;
    this.buffers = buffers;
    this.gains = new Map(
      [...buffers.keys()].map((stem) => {
        const gain = context.createGain();
        gain.connect(destination);
        return [stem, gain];
      }),
    );
    this.duration = Math.max(...[...buffers.values()].map((b) => b.duration));
    this.clock = new PlaybackClock(this.duration);
  }

  /** Decodes every stem; FLAC and WAV are both decoded by the browser. */
  static async load(
    context: AudioContext,
    stems: StemAudio[],
    destination: AudioNode,
  ): Promise<BufferEngine> {
    const decoded = await Promise.all(
      stems.map(async ({ stem, blob }) =>
        [stem, await context.decodeAudioData(await blob.arrayBuffer())] as const
      ),
    );
    return new BufferEngine(context, new Map(decoded), destination);
  }

  time(): PlayerTime {
    return {
      position: this.heardPosition(),
      duration: this.duration,
      playing: this.clock.playing,
      rate: this.rate,
    };
  }

  async play(): Promise<void> {
    if (this.clock.playing) return;
    if (this.clock.position(0) >= this.duration) {
      this.clock.seek(this.loop?.start ?? 0, 0);
    }
    await this.context.resume().catch(() => undefined);
    if (this.context.state !== "running") throw new Error(BLOCKED_PLAYBACK_MESSAGE);
    this.startSources();
  }

  pause(): void {
    if (!this.clock.playing) return;
    // Resume from what was heard: audio still inside the pitch shifter when
    // pausing is played again rather than skipped.
    const heard = this.heardPosition();
    this.clock.stop(this.context.currentTime);
    this.clock.seek(heard, 0);
    this.stopSources();
  }

  seek(seconds: number): void {
    const target = seekTarget(seconds, this.duration, this.loop);
    if (this.clock.playing) {
      this.stopSources();
      this.clock.seek(target, 0);
      this.startSources();
    } else {
      this.clock.seek(target, 0);
    }
  }

  setGain(stem: Stem, gain: number): void {
    const node = this.gains.get(stem);
    if (node) node.gain.value = gain;
  }

  setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    this.clock.setRate(rate, this.context.currentTime);
    for (const source of this.sources) source.playbackRate.value = rate;
  }

  setLoop(loop: LoopRegion | null): void {
    const now = this.context.currentTime;
    this.clock.setLoop(loop, now);
    this.loop = loop;
    if (loop && this.clock.position(now) >= loop.end) {
      // Past the new loop: jump to its start.
      this.seek(loop.start);
      return;
    }
    for (const source of this.sources) this.applyLoop(source);
  }

  setOutputDelay(seconds: number): void {
    this.outputDelay = seconds;
  }

  channels(stem: Stem): [Float32Array, Float32Array] | null {
    const buffer = this.buffers.get(stem);
    if (!buffer) return null;
    const left = buffer.getChannelData(0);
    return [left, buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left];
  }

  tick(): void {
    // The end is handled by the sources' ended event.
  }

  release(): void {
    this.stopSources();
    this.clock.stop(0);
    this.gains.forEach((gain) => gain.disconnect());
  }

  /** The position heard now: the clock, less the output delay. */
  private heardPosition(): number {
    return this.clock.position(this.context.currentTime - this.outputDelay);
  }

  private applyLoop(source: AudioBufferSourceNode): void {
    source.loop = this.loop !== null;
    if (this.loop) {
      source.loopStart = this.loop.start;
      source.loopEnd = this.loop.end;
    }
  }

  private startSources(): void {
    const when = this.context.currentTime + START_LEAD_SECONDS;
    const offset = this.clock.position(0);
    this.sources = [...this.buffers].map(([stem, buffer]) => {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.rate;
      this.applyLoop(source);
      source.connect(this.gains.get(stem)!);
      source.start(when, offset);
      return source;
    });
    const current = this.sources;
    // All sources end together (never while looping); the first one's end
    // stops playback at the end.
    current[0].onended = () => {
      if (this.sources !== current) return;
      this.sources = [];
      this.clock.ended();
    };
    this.clock.start(when);
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
