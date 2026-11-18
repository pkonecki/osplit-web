import { clickSamples } from "../analysis/click";
import { type BeatGrid, beatIndexAt, isDownbeat } from "../analysis/grid";
import type { LoopRegion } from "../practice";

/** How often the scheduler runs while playing. */
const SCHEDULE_MS = 25;
/** How far ahead (audio-clock seconds) clicks are scheduled. */
const LOOKAHEAD_SECONDS = 0.12;
/**
 * A click computed this close to one already scheduled is the same beat
 * (the position read from the player jitters, notably with streaming).
 */
const SAME_CLICK_SECONDS = 0.06;
/** A click due this long ago is dropped rather than played late. */
const LATE_SECONDS = 0.01;

/** What the scheduler needs from the player at each step. */
export interface ClickTimeline {
  /** Position heard now (track seconds), whether playing, and speed. */
  position: number;
  playing: boolean;
  rate: number;
  duration: number;
  loop: LoopRegion | null;
}

/** A beat's click to schedule: when it is heard, and whether it is accented. */
export interface ScheduledClick {
  when: number;
  accent: boolean;
}

/**
 * The clicks due in (now, now + horizon]: beats ahead of `position`,
 * converted to audio-clock time at `rate`, wrapping at the loop end.
 */
export function clicksAhead(
  grid: BeatGrid,
  timeline: ClickTimeline,
  now: number,
  horizon: number,
): ScheduledClick[] {
  const clicks: ScheduledClick[] = [];
  const { rate, loop } = timeline;
  let position = timeline.position;
  let remaining = horizon * rate;
  let elapsed = 0;
  for (let pass = 0; pass < 8 && remaining > 1e-9; pass++) {
    const end = loop && position < loop.end ? loop.end : timeline.duration;
    const span = Math.min(remaining, end - position);
    if (!(span > 0)) break;
    let index = Math.max(0, beatIndexAt(grid, position - 1e-9) + 1);
    for (; index < grid.beats.length && grid.beats[index] < position + span; index++) {
      const beat = grid.beats[index];
      if (beat < position) continue;
      clicks.push({
        when: now + elapsed + (beat - position) / rate,
        accent: isDownbeat(grid, index),
      });
    }
    remaining -= span;
    elapsed += span / rate;
    if (!loop || position + span < loop.end - 1e-9) break;
    position = loop.start;
  }
  return clicks;
}

/**
 * Plays the click track live: every few milliseconds, the clicks heard in
 * the next moment are scheduled on the audio clock from the player's
 * position. The click skips the pitch shifter, so it is timed against the
 * position heard (which allows for the shifter's delay). With decoded
 * playback it is sample-tight; streaming playback reports its position
 * less precisely, so clicks can be some 30 ms off.
 */
export class ClickScheduler {
  private readonly context: AudioContext;
  private readonly destination: AudioNode;
  private readonly timeline: () => ClickTimeline;
  /** Created on first use, so a project that never clicks adds no nodes. */
  private gain: GainNode | null = null;
  private buffers: { accent: AudioBuffer; normal: AudioBuffer } | null = null;
  private grid: BeatGrid | null = null;
  private level = 0;
  private timer: number | undefined;
  private holdUntil = 0;
  private lastWhen = -Infinity;
  private scheduled: { when: number; source: AudioBufferSourceNode }[] = [];

  constructor(
    context: AudioContext,
    destination: AudioNode,
    timeline: () => ClickTimeline,
  ) {
    this.context = context;
    this.destination = destination;
    this.timeline = timeline;
  }

  setGrid(grid: BeatGrid | null): void {
    this.grid = grid;
    this.restart();
  }

  setLevel(level: number): void {
    this.level = level;
    if (this.gain) this.gain.gain.value = level;
    this.update();
  }

  /**
   * The position jumped or its pace changed (seek, play, speed, loop):
   * drops clicks not yet heard and schedules again, after `delay` seconds
   * when playback only starts then (start lead, the shifter's delay).
   */
  restart(delay = 0): void {
    this.cancel();
    this.holdUntil = this.context.currentTime + delay;
    this.update();
  }

  /** Starts or stops the timer for the current state, and schedules. */
  update(): void {
    const active = this.grid !== null && this.level > 0 && this.timeline().playing;
    if (!active) {
      this.cancel();
      if (this.timer !== undefined) window.clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    this.timer ??= window.setInterval(() => this.step(), SCHEDULE_MS);
    this.step();
  }

  release(): void {
    this.grid = null;
    this.update();
    this.gain?.disconnect();
    this.gain = null;
  }

  private step(): void {
    const timeline = this.timeline();
    const grid = this.grid;
    if (!grid || !timeline.playing || this.level <= 0) {
      this.update();
      return;
    }
    const now = this.context.currentTime;
    if (now < this.holdUntil) return;
    const output = this.output();
    this.scheduled = this.scheduled.filter((click) => click.when > now - 0.1);
    for (const click of clicksAhead(grid, timeline, now, LOOKAHEAD_SECONDS)) {
      if (click.when < now - LATE_SECONDS) continue;
      if (click.when < this.lastWhen + SAME_CLICK_SECONDS) continue;
      const source = new AudioBufferSourceNode(this.context, {
        buffer: click.accent ? output.buffers.accent : output.buffers.normal,
      });
      source.connect(output.gain);
      source.start(Math.max(now, click.when));
      this.scheduled.push({ when: click.when, source });
      this.lastWhen = click.when;
    }
  }

  private output(): { gain: GainNode; buffers: { accent: AudioBuffer; normal: AudioBuffer } } {
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = this.level;
      this.gain.connect(this.destination);
    }
    this.buffers ??= {
      accent: toBuffer(this.context, clickSamples(true, this.context.sampleRate)),
      normal: toBuffer(this.context, clickSamples(false, this.context.sampleRate)),
    };
    return { gain: this.gain, buffers: this.buffers };
  }

  /** Stops clicks scheduled but not yet heard. */
  private cancel(): void {
    for (const { source } of this.scheduled) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
      source.disconnect();
    }
    this.scheduled = [];
    this.lastWhen = -Infinity;
  }
}

function toBuffer(context: BaseAudioContext, samples: Float32Array): AudioBuffer {
  const buffer = new AudioBuffer({
    length: samples.length,
    numberOfChannels: 1,
    sampleRate: context.sampleRate,
  });
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}
