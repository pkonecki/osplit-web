import {
  beatKind,
  type ClickKind,
  type ClickOptions,
  clickSamples,
  countInClicks,
  DEFAULT_CLICK_OPTIONS,
} from "../analysis/click";
import { type BeatGrid, beatIndexAt } from "../analysis/grid";
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

/** A click to schedule: when it is heard, and its sound. */
export interface ScheduledClick {
  when: number;
  kind: ClickKind;
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
  options: ClickOptions = DEFAULT_CLICK_OPTIONS,
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
    // From the beat before, for its subdivisions after `position`.
    let index = Math.max(0, beatIndexAt(grid, position - 1e-9));
    for (; index < grid.beats.length && grid.beats[index] < position + span; index++) {
      const beat = grid.beats[index];
      const push = (time: number, kind: ClickKind) => {
        if (time < position || time >= position + span) return;
        clicks.push({ when: now + elapsed + (time - position) / rate, kind });
      };
      push(beat, beatKind(grid, index, options));
      const next = grid.beats[index + 1] ?? beat + 60 / grid.bpm;
      for (let part = 1; part < options.subdivision; part++) {
        push(beat + ((next - beat) * part) / options.subdivision, "sub");
      }
    }
    clicks.sort((a, b) => a.when - b.when);
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
  private buffers: Record<ClickKind, AudioBuffer> | null = null;
  private grid: BeatGrid | null = null;
  private options: ClickOptions = DEFAULT_CLICK_OPTIONS;
  private level = 0;
  private timer: number | undefined;
  private holdUntil = 0;
  private lastWhen = -Infinity;
  private scheduled: { when: number; source: AudioBufferSourceNode }[] = [];
  /**
   * The count-in's clicks, apart from the click track's: those are dropped
   * whenever the click restarts or stops (it isn't playing yet during the
   * count-in), which would cut the count-in after its first beat.
   */
  private countInSources: AudioBufferSourceNode[] = [];

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

  setOptions(options: ClickOptions): void {
    if (options.accent === this.options.accent && options.subdivision === this.options.subdivision) return;
    this.options = options;
    this.restart();
  }

  /**
   * Plays `bars` bars of count-in clicks from now, a beat every
   * `beatSeconds`, whether or not the click is on. Returns when the count-in
   * ends (audio-clock seconds).
   */
  countIn(bars: number, beatsPerBar: number, beatSeconds: number): number {
    const output = this.output();
    const start = this.context.currentTime + 0.05;
    // Heard even when the click is muted, at a sensible level.
    const gain = this.context.createGain();
    gain.gain.value = this.level > 0 ? this.level : 0.8;
    gain.connect(this.destination);
    this.stopCountIn();
    for (const click of countInClicks(beatsPerBar, beatSeconds, bars, start, this.options)) {
      const source = new AudioBufferSourceNode(this.context, { buffer: output.buffers[click.kind] });
      source.connect(gain);
      source.start(click.when);
      this.countInSources.push(source);
    }
    const end = start + bars * beatsPerBar * beatSeconds;
    // Let go of the nodes once the last click has played.
    const sources = this.countInSources;
    window.setTimeout(() => {
      if (this.countInSources === sources) this.countInSources = [];
      gain.disconnect();
    }, (end - this.context.currentTime + 1) * 1000);
    return end;
  }

  /** Stops the count-in's clicks not yet heard (the count-in was stopped). */
  stopCountIn(): void {
    stopSources(this.countInSources);
    this.countInSources = [];
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
    for (const click of clicksAhead(grid, timeline, now, LOOKAHEAD_SECONDS, this.options)) {
      if (click.when < now - LATE_SECONDS) continue;
      if (click.when < this.lastWhen + SAME_CLICK_SECONDS) continue;
      const source = new AudioBufferSourceNode(this.context, {
        buffer: output.buffers[click.kind],
      });
      source.connect(output.gain);
      source.start(Math.max(now, click.when));
      this.scheduled.push({ when: click.when, source });
      this.lastWhen = click.when;
    }
  }

  private output(): { gain: GainNode; buffers: Record<ClickKind, AudioBuffer> } {
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = this.level;
      this.gain.connect(this.destination);
    }
    this.buffers ??= {
      accent: toBuffer(this.context, clickSamples("accent", this.context.sampleRate)),
      beat: toBuffer(this.context, clickSamples("beat", this.context.sampleRate)),
      sub: toBuffer(this.context, clickSamples("sub", this.context.sampleRate)),
    };
    return { gain: this.gain, buffers: this.buffers };
  }

  /** Stops clicks scheduled but not yet heard. */
  private cancel(): void {
    stopSources(this.scheduled.map(({ source }) => source));
    this.scheduled = [];
    this.lastWhen = -Infinity;
  }
}

function stopSources(sources: AudioBufferSourceNode[]): void {
  for (const source of sources) {
    try {
      source.stop();
    } catch {
      // Already ended.
    }
    source.disconnect();
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
