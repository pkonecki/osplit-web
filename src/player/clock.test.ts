import { describe, expect, it } from "vitest";
import { PlaybackClock } from "./clock";

describe("playback clock", () => {
  it("follows the audio clock from the start time", () => {
    const clock = new PlaybackClock(10);
    expect(clock.position(5)).toBe(0);
    clock.start(1);
    expect(clock.position(0.5)).toBe(0); // scheduled, not started yet
    expect(clock.position(3)).toBe(2);
    clock.stop(4);
    expect(clock.playing).toBe(false);
    expect(clock.position(100)).toBe(3);
  });

  it("stops at the duration", () => {
    const clock = new PlaybackClock(10);
    clock.start(0);
    expect(clock.position(20)).toBe(10);
    clock.ended();
    expect(clock.position(30)).toBe(10);
  });

  it("scales elapsed time by the rate, from where the rate changed", () => {
    const clock = new PlaybackClock(100);
    clock.start(0);
    clock.setRate(0.5, 4); // 4 s at full speed
    expect(clock.position(8)).toBe(6); // then 4 s at half speed
    clock.setRate(1.5, 8);
    expect(clock.position(10)).toBe(9);
    expect(clock.speed).toBe(1.5);
  });

  it("keeps a rate set while paused for the next run", () => {
    const clock = new PlaybackClock(100);
    clock.setRate(0.5, 0);
    clock.start(2);
    expect(clock.position(6)).toBe(2);
  });

  it("changes the rate during the start lead without moving", () => {
    const clock = new PlaybackClock(100);
    clock.seek(5, 1);
    clock.start(1);
    clock.setRate(2, 0.9);
    expect(clock.position(1)).toBe(5);
    expect(clock.position(2)).toBe(7);
  });

  it("wraps inside a loop", () => {
    const clock = new PlaybackClock(100);
    clock.seek(1, 0);
    clock.setLoop({ start: 2, end: 4 }, 0);
    clock.start(0);
    expect(clock.position(2)).toBe(3);
    expect(clock.position(3)).toBe(2);
    expect(clock.position(4.5)).toBeCloseTo(3.5);
    // Clearing the loop continues from the wrapped position.
    clock.setLoop(null, 4.5);
    expect(clock.position(6)).toBeCloseTo(5);
  });

  it("combines loop and rate", () => {
    const clock = new PlaybackClock(100);
    clock.seek(2, 0);
    clock.setLoop({ start: 2, end: 4 }, 0);
    clock.setRate(0.5, 0);
    clock.start(0);
    expect(clock.position(3)).toBe(3.5);
    expect(clock.position(5)).toBeCloseTo(2.5);
  });

  it("restarts from a seek while playing", () => {
    const clock = new PlaybackClock(100);
    clock.start(0);
    clock.seek(50, 3.05);
    expect(clock.position(3)).toBe(50);
    expect(clock.position(4.05)).toBe(51);
  });
});
