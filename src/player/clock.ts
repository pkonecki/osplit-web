import { type LoopRegion, wrapPosition } from "../practice";

/**
 * The track position of sources driven by the audio clock: where a run
 * started in the track (`offset`), when it started on the audio clock, and
 * how fast it plays. A rate or loop change while playing starts a new
 * segment from the current position, as the sources keep playing.
 */
export class PlaybackClock {
  private offset = 0;
  private startedAt = 0;
  private rate = 1;
  private loop: LoopRegion | null = null;
  private running = false;

  readonly duration: number;

  constructor(duration: number) {
    this.duration = duration;
  }

  get playing(): boolean {
    return this.running;
  }

  get speed(): number {
    return this.rate;
  }

  /** Track position at audio-clock time `now`. */
  position(now: number): number {
    if (!this.running) return this.offset;
    const raw = this.offset + Math.max(0, now - this.startedAt) * this.rate;
    return Math.min(this.duration, wrapPosition(raw, this.loop));
  }

  /** Starts playing from the current offset at audio-clock time `when`. */
  start(when: number): void {
    this.startedAt = when;
    this.running = true;
  }

  /** Stops at the position reached at `now`. */
  stop(now: number): void {
    this.offset = this.position(now);
    this.running = false;
  }

  /** Playback reached the end of the track. */
  ended(): void {
    this.offset = this.duration;
    this.running = false;
  }

  /** Moves to `seconds`; while playing, the sources restart at `when`. */
  seek(seconds: number, when: number): void {
    this.offset = seconds;
    this.startedAt = when;
  }

  setRate(rate: number, now: number): void {
    this.split(now);
    this.rate = rate;
  }

  setLoop(loop: LoopRegion | null, now: number): void {
    this.split(now);
    this.loop = loop;
  }

  /** Starts a new segment at `now`, from the position reached. */
  private split(now: number): void {
    if (!this.running) return;
    this.offset = this.position(now);
    this.startedAt = Math.max(now, this.startedAt);
  }
}
