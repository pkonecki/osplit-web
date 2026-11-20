/**
 * The visible part of the track in the timeline lanes (loop ruler, chord
 * lane, waveforms): a window `span` seconds long from `start`. The full
 * view shows the whole track; zooming in narrows it.
 */
export interface TimeView {
  start: number;
  span: number;
}

/** The narrowest view, in seconds (shorter tracks show whole). */
export const MIN_SPAN = 2;

/** Margin kept before the playhead when the view jumps to follow it. */
const FOLLOW_LEAD = 0.05;

export function fullView(duration: number): TimeView {
  return { start: 0, span: Math.max(0, duration) };
}

/** Keeps `view` inside the track and no narrower than MIN_SPAN. */
export function clampView(view: TimeView, duration: number): TimeView {
  if (!(duration > 0)) return fullView(0);
  const span = Math.max(Math.min(MIN_SPAN, duration), Math.min(duration, view.span));
  const start = Math.max(0, Math.min(duration - span, view.start));
  return { start, span };
}

export function isZoomed(view: TimeView, duration: number): boolean {
  return duration > 0 && view.span < duration - 1e-6;
}

/** Where `time` falls in the view: 0 at its left edge, 1 at its right. */
export function viewFraction(view: TimeView, time: number): number {
  return view.span > 0 ? (time - view.start) / view.span : 0;
}

/** The track time at `fraction` across the view. */
export function viewTime(view: TimeView, fraction: number): number {
  return view.start + fraction * view.span;
}

/**
 * Zooms in by `factor` (below 1 zooms out), keeping the time `anchor` at
 * the same place on screen.
 */
export function zoomView(
  view: TimeView,
  factor: number,
  anchor: number,
  duration: number,
): TimeView {
  if (!(factor > 0)) return clampView(view, duration);
  const fraction = viewFraction(view, anchor);
  const span = view.span / factor;
  return clampView({ start: anchor - fraction * span, span }, duration);
}

/** Moves the view by `seconds` (positive: later in the track). */
export function panView(view: TimeView, seconds: number, duration: number): TimeView {
  return clampView({ start: view.start + seconds, span: view.span }, duration);
}

/** A view showing `start`–`end` with a margin on each side. */
export function viewAround(
  start: number,
  end: number,
  duration: number,
  margin = 0.1,
): TimeView {
  const length = Math.max(0, end - start);
  const span = length * (1 + 2 * margin);
  return clampView({ start: start - length * margin, span }, duration);
}

export function inView(view: TimeView, time: number): boolean {
  return time >= view.start && time <= view.start + view.span;
}

/**
 * Follows the playhead a page at a time: when it leaves the view it was in
 * (played past the right edge, or wrapped back to a loop start off screen),
 * the view jumps to show it near the left edge. A playhead already outside
 * the view (the user looked elsewhere) is left alone.
 */
export function followView(
  view: TimeView,
  wasInView: boolean,
  position: number,
  duration: number,
): TimeView {
  if (!wasInView || inView(view, position) || !isZoomed(view, duration)) return view;
  return clampView({ start: position - view.span * FOLLOW_LEAD, span: view.span }, duration);
}

/**
 * Converts a wheel event's delta to pixels (some browsers report lines or
 * pages).
 */
export function wheelPixels(delta: number, mode: number, page: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * page;
  return delta;
}

/** Zoom factor for a vertical wheel movement of `pixels` (up zooms in). */
export function wheelZoomFactor(pixels: number): number {
  return Math.exp(-pixels * 0.002);
}
