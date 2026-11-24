import type { ChartBar } from "./analysis/chart";
import type { ProjectMarker } from "./types";

/**
 * Markers name the parts of a song (intro, verse, chorus…) at a bar. They
 * are kept sorted by bar, one per bar. Each also keeps its time, so when the
 * beat grid changes (bar 1 moved, tempo ×2) it is moved to the bar nearest
 * that time. A marker's section runs from its bar to the bar before the next
 * marker, or to the end of the song.
 */

/** Names offered in the Add marker panel; they only fill in the name. */
export const MARKER_PRESETS = [
  "Intro",
  "Verse",
  "Pre-chorus",
  "Chorus",
  "Bridge",
  "Solo",
  "Break",
  "Outro",
] as const;

export const MAX_MARKER_NAME = 40;

export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_MARKER_NAME);
}

/** `markers` with `marker` added, replacing one already at its bar. */
export function addMarker(markers: readonly ProjectMarker[], marker: ProjectMarker): ProjectMarker[] {
  const name = cleanName(marker.name) || "Marker";
  return [...markers.filter((item) => item.bar !== marker.bar), { ...marker, name }]
    .sort((a, b) => a.bar - b.bar);
}

export function renameMarker(markers: readonly ProjectMarker[], bar: number, name: string): ProjectMarker[] {
  const clean = cleanName(name);
  if (!clean) return [...markers];
  return markers.map((item) => item.bar === bar ? { ...item, name: clean } : item);
}

export function removeMarker(markers: readonly ProjectMarker[], bar: number): ProjectMarker[] {
  return markers.filter((item) => item.bar !== bar);
}

/** The bar numbers a marker's section spans: its bar to the bar before the next marker. */
export function sectionBars(
  markers: readonly ProjectMarker[],
  index: number,
  lastBar: number,
): { first: number; last: number } {
  const first = markers[index].bar;
  const next = markers[index + 1];
  return { first, last: Math.max(first, next ? next.bar - 1 : lastBar) };
}

/** The loop a marker's section makes, in seconds, from the chart's bars. */
export function sectionLoop(
  markers: readonly ProjectMarker[],
  index: number,
  bars: readonly ChartBar[],
): { start: number; end: number } | null {
  if (!bars.length) return null;
  const { first, last } = sectionBars(markers, index, bars[bars.length - 1].number);
  const from = bars.find((bar) => bar.number >= first);
  const to = [...bars].reverse().find((bar) => bar.number <= last);
  if (!from || !to || to.end <= from.start) return null;
  return { start: from.start, end: to.end };
}

/** Index of the marker whose section holds bar `bar`, or −1 before the first. */
export function markerIndexAtBar(markers: readonly ProjectMarker[], bar: number): number {
  let found = -1;
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].bar <= bar) found = i;
    else break;
  }
  return found;
}

/**
 * Moves each marker to the bar starting nearest its time (after the grid
 * changed). Two markers landing on one bar keep the first. Returns the same
 * array when nothing moved.
 */
export function snapMarkers(markers: readonly ProjectMarker[], bars: readonly ChartBar[]): readonly ProjectMarker[] {
  if (!bars.length || !markers.length) return markers;
  let moved = false;
  const result: ProjectMarker[] = [];
  for (const marker of markers) {
    let best = bars[0];
    for (const bar of bars) {
      if (Math.abs(bar.start - marker.time) < Math.abs(best.start - marker.time)) best = bar;
    }
    if (best.number !== marker.bar) moved = true;
    if (result.some((item) => item.bar === best.number)) {
      moved = true;
      continue;
    }
    result.push({ ...marker, bar: best.number });
  }
  if (!moved) return markers;
  return result.sort((a, b) => a.bar - b.bar);
}

/** The marker before or after `bar` (for Shift+← / Shift+→). */
export function stepMarker(
  markers: readonly ProjectMarker[],
  bar: number,
  direction: -1 | 1,
  atStart: boolean,
): ProjectMarker | null {
  if (direction === 1) return markers.find((item) => item.bar > bar) ?? null;
  const before = markers.filter((item) => item.bar < bar || (item.bar === bar && !atStart));
  return before[before.length - 1] ?? null;
}
