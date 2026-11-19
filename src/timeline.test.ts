import { describe, expect, it } from "vitest";
import {
  clampView,
  followView,
  fullView,
  isZoomed,
  MIN_SPAN,
  panView,
  viewAround,
  viewFraction,
  viewTime,
  wheelPixels,
  wheelZoomFactor,
  zoomView,
} from "./timeline";

describe("timeline view", () => {
  it("starts with the whole track", () => {
    expect(fullView(120)).toEqual({ start: 0, span: 120 });
    expect(isZoomed(fullView(120), 120)).toBe(false);
  });

  it("stays inside the track and no narrower than the minimum", () => {
    expect(clampView({ start: -5, span: 10 }, 100)).toEqual({ start: 0, span: 10 });
    expect(clampView({ start: 95, span: 10 }, 100)).toEqual({ start: 90, span: 10 });
    expect(clampView({ start: 10, span: 0.1 }, 100)).toEqual({ start: 10, span: MIN_SPAN });
    expect(clampView({ start: 10, span: 500 }, 100)).toEqual({ start: 0, span: 100 });
    // A track shorter than the minimum shows whole.
    expect(clampView({ start: 0, span: 0.5 }, 1)).toEqual({ start: 0, span: 1 });
  });

  it("maps times to view fractions and back", () => {
    const view = { start: 20, span: 10 };
    expect(viewFraction(view, 25)).toBe(0.5);
    expect(viewTime(view, 0.5)).toBe(25);
    expect(viewFraction(view, 10)).toBe(-1);
  });

  it("zooms around the anchor, keeping it in place", () => {
    const view = zoomView(fullView(100), 4, 50, 100);
    expect(view).toEqual({ start: 37.5, span: 25 });
    const near = zoomView(fullView(100), 2, 10, 100);
    expect(viewFraction(near, 10)).toBeCloseTo(0.1);
    // Zooming out past the track returns to the full view.
    expect(zoomView(view, 0.1, 40, 100)).toEqual(fullView(100));
  });

  it("pans within the track", () => {
    const view = { start: 10, span: 20 };
    expect(panView(view, 5, 100)).toEqual({ start: 15, span: 20 });
    expect(panView(view, -50, 100)).toEqual({ start: 0, span: 20 });
    expect(panView(view, 500, 100)).toEqual({ start: 80, span: 20 });
  });

  it("frames a region with a margin", () => {
    expect(viewAround(10, 20, 100)).toEqual({ start: 9, span: 12 });
    expect(viewAround(0, 1, 100).span).toBe(MIN_SPAN);
  });

  it("follows the playhead a page at a time", () => {
    const view = { start: 10, span: 20 };
    // Still in view: unchanged.
    expect(followView(view, true, 25, 100)).toBe(view);
    // Played past the right edge: jumps so it is near the left.
    expect(followView(view, true, 30.1, 100)).toEqual({ start: 29.1, span: 20 });
    // Wrapped back to a loop start off screen to the left.
    expect(followView(view, true, 2, 100)).toEqual({ start: 1, span: 20 });
    // The user had panned away: left alone.
    expect(followView(view, false, 60, 100)).toBe(view);
    // The full view never moves.
    expect(followView(fullView(100), true, 50, 100)).toEqual(fullView(100));
  });

  it("turns wheel movement into a zoom factor", () => {
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(1, 2, 800)).toBe(800);
    expect(wheelPixels(-40, 0, 800)).toBe(-40);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1);
  });
});
