import { playerTime } from "../player";
import { state } from "../state";
import {
  clampView,
  followView,
  fullView,
  inView,
  isZoomed,
  type TimeView,
  viewFraction,
} from "../timeline";

/**
 * The zoom and scroll of the timeline lanes, kept for this page only: it
 * returns to the whole track when another project opens or the track length
 * changes. Changes notify the listeners, which redraw the lanes.
 */

let view: TimeView = fullView(0);
let viewDuration = 0;
let viewProject: string | null = null;
let playheadWasInView = true;
/** While the user drags in the timeline, the view does not follow the playhead. */
let holdFollow = false;
const listeners: (() => void)[] = [];

/** Returns to the whole track when the project or the track length changed. */
function sync(): void {
  const duration = playerTime().duration;
  const project = state.selectedProject?.id ?? null;
  if (duration !== viewDuration || project !== viewProject) {
    view = fullView(duration);
    viewDuration = duration;
    viewProject = project;
    playheadWasInView = true;
  }
}

/**
 * The current view, for a track `duration` seconds long (by default the
 * player's; the chord lane may know the length before the player does).
 */
export function timelineView(duration = playerTime().duration): TimeView {
  sync();
  if (duration === viewDuration) return view;
  return viewDuration > 0 ? clampView(view, duration) : fullView(duration);
}

export function timelineZoomed(): boolean {
  const duration = playerTime().duration;
  return isZoomed(timelineView(duration), duration);
}

/** Sets the view (kept inside the track) and redraws the lanes. */
export function setTimelineView(next: TimeView): void {
  sync();
  const duration = playerTime().duration;
  const clamped = clampView(next, duration);
  if (clamped.start === view.start && clamped.span === view.span) return;
  view = clamped;
  playheadWasInView = inView(view, playerTime().position);
  for (const listener of listeners) listener();
}

export function onTimelineChange(listener: () => void): void {
  listeners.push(listener);
}

export function holdTimelineFollow(hold: boolean): void {
  holdFollow = hold;
  if (!hold) playheadWasInView = inView(view, playerTime().position);
}

/**
 * Moves the view along when the playhead leaves it (called whenever the
 * playhead moves).
 */
export function followPlayhead(): void {
  const { position, duration } = playerTime();
  const current = timelineView(duration);
  if (!holdFollow) {
    const next = followView(current, playheadWasInView, position, duration);
    if (next !== current) {
      setTimelineView(next);
      return;
    }
  }
  playheadWasInView = inView(current, position);
}

/** Percent across a lane for `time`, in the current view. */
export function lanePercent(time: number, duration = playerTime().duration): number {
  return viewFraction(timelineView(duration), time) * 100;
}

/** The track time at `clientX` over a lane, in the current view. */
export function laneTime(element: HTMLElement, clientX: number): number {
  const duration = playerTime().duration;
  const current = timelineView(duration);
  const rect = element.getBoundingClientRect();
  const fraction = rect.width ? (clientX - rect.left) / rect.width : 0;
  const time = current.start + Math.max(0, Math.min(1, fraction)) * current.span;
  return Math.max(0, Math.min(duration, time));
}
