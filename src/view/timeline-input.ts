import { playerTime } from "../player";
import { MIN_LOOP_SECONDS, normalizeLoop } from "../practice";
import {
  isZoomed,
  panView,
  type TimeView,
  viewTime,
  wheelPixels,
  wheelZoomFactor,
  zoomView,
} from "../timeline";
import type { ProjectLoop } from "../types";
import { holdTimelineFollow, laneTime, setTimelineView, timelineView } from "./timeline";

/**
 * Pointer and wheel input on the timeline.
 *
 * Lanes (loop ruler, chord lane, waveforms): dragging a loop edge moves it
 * (while the loop is on); dragging anywhere else moves along the track when
 * zoomed in; two fingers pinch to zoom. A press without movement stays a
 * click, which seeks. Ctrl/⌘ + wheel (or a trackpad pinch) zooms, and a
 * sideways wheel moves along. A plain wheel scrolls the page.
 *
 * Overview: a plain wheel zooms; dragging moves the window in view (a press
 * outside it centres it there first).
 */

export interface TimelineCallbacks {
  loop(): ProjectLoop | undefined;
  /** Shows and plays a loop while dragging, without saving it. */
  preview(loop: ProjectLoop): void;
  /** The drag ended on `loop`: save it. */
  commit(loop: ProjectLoop): void;
  /** Moves a dragged position onto the beat grid (modifier keys may opt out). */
  snap(seconds: number, event: PointerEvent): number;
}

const LANES = ".loop-ruler, .chord-lane, .waveform";
/** Movement (CSS pixels) that turns a press into a drag. */
const DRAG_THRESHOLD = 4;
/** How near a loop edge (CSS pixels) a press grabs it. */
const EDGE_REACH = 12;
/** Near a lane's side (CSS pixels), a dragged edge scrolls the view. */
const SCROLL_ZONE = 28;
/** Fraction of the view scrolled per second at the very side. */
const SCROLL_SPEED = 1.2;

type Drag =
  | { kind: "pan"; element: HTMLElement; startX: number; view: TimeView; moved: boolean }
  | {
    kind: "edge";
    element: HTMLElement;
    edge: "start" | "end";
    loop: ProjectLoop;
    moved: boolean;
    lastX: number;
    lastEvent: PointerEvent;
  }
  | { kind: "overview"; element: HTMLElement; grab: number; moved: boolean; startX: number }
  | {
    kind: "pinch";
    element: HTMLElement;
    view: TimeView;
    distance: number;
    anchor: number;
  };

let suppressClick = false;

/** True once after a drag, so the click that follows it doesn't seek. */
export function takeSuppressedClick(): boolean {
  const suppressed = suppressClick;
  suppressClick = false;
  return suppressed;
}

/** The loop edge within reach of `clientX` over `lane`, if the loop is on. */
function edgeAt(
  lane: HTMLElement,
  clientX: number,
  loop: ProjectLoop | undefined,
): "start" | "end" | null {
  const duration = playerTime().duration;
  if (!loop?.enabled || !(duration > 0)) return null;
  const rect = lane.getBoundingClientRect();
  if (!rect.width) return null;
  const view = timelineView(duration);
  const x = (time: number) => rect.left + ((time - view.start) / view.span) * rect.width;
  const start = Math.abs(clientX - x(loop.start));
  const end = Math.abs(clientX - x(loop.end));
  if (Math.min(start, end) > EDGE_REACH) return null;
  return end < start ? "end" : "start";
}

export function installTimelineInput(root: HTMLElement, callbacks: TimelineCallbacks): void {
  let drag: Drag | null = null;
  const pointers = new Map<number, number>();
  let scrollFrame = 0;
  let scrollTime = 0;

  const end = () => {
    // A drag, a pinch, or a press on a loop edge doesn't seek.
    if (drag && (drag.kind !== "pan" || drag.moved)) suppressClick = true;
    if (drag?.kind === "edge" && drag.moved) callbacks.commit(drag.loop);
    drag = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    holdTimelineFollow(false);
  };

  /** Moves the dragged edge to the pointer (after the view moved, too). */
  const moveEdge = (state: Extract<Drag, { kind: "edge" }>) => {
    const duration = playerTime().duration;
    const time = callbacks.snap(laneTime(state.element, state.lastX), state.lastEvent);
    const { loop } = state;
    const start = state.edge === "start" ? Math.min(time, loop.end - MIN_LOOP_SECONDS) : loop.start;
    const finish = state.edge === "end" ? Math.max(time, loop.start + MIN_LOOP_SECONDS) : loop.end;
    const region = normalizeLoop(start, finish, duration);
    if (!region) return;
    state.loop = { ...loop, ...region };
    callbacks.preview(state.loop);
  };

  /** While an edge is held near a lane's side, scrolls the view that way. */
  const scrollWhileHeld = (now: number) => {
    scrollFrame = 0;
    if (drag?.kind !== "edge") return;
    const rect = drag.element.getBoundingClientRect();
    const duration = playerTime().duration;
    const view = timelineView(duration);
    const left = rect.left + SCROLL_ZONE - drag.lastX;
    const right = drag.lastX - (rect.right - SCROLL_ZONE);
    const push = left > 0 ? -left : right > 0 ? right : 0;
    if (!push || !isZoomed(view, duration)) return;
    const seconds = scrollTime ? (now - scrollTime) / 1000 : 0;
    scrollTime = now;
    const amount = (Math.min(push, SCROLL_ZONE) / SCROLL_ZONE) * SCROLL_SPEED * view.span * seconds;
    setTimelineView(panView(view, amount, duration));
    moveEdge(drag);
    scrollFrame = requestAnimationFrame(scrollWhileHeld);
  };

  root.addEventListener("pointerdown", (event) => {
    const duration = playerTime().duration;
    if (event.button !== 0 || !(duration > 0)) return;
    const target = event.target as HTMLElement;
    const overview = target.closest<HTMLElement>(".overview");
    const lane = target.closest<HTMLElement>(LANES);
    if (!overview && !lane) return;
    suppressClick = false;

    if (overview) {
      const time = overviewTime(overview, event.clientX, duration);
      let view = timelineView(duration);
      if (time < view.start || time > view.start + view.span) {
        view = { start: time - view.span / 2, span: view.span };
        setTimelineView(view);
        view = timelineView(duration);
      }
      drag = { kind: "overview", element: overview, grab: time - view.start, moved: false, startX: event.clientX };
      overview.setPointerCapture(event.pointerId);
      holdTimelineFollow(true);
      event.preventDefault();
      return;
    }

    pointers.set(event.pointerId, event.clientX);
    if (pointers.size === 2 && drag?.kind === "pan") {
      // A second finger: pinch to zoom instead of moving along.
      const [a, b] = [...pointers.values()];
      const view = timelineView(duration);
      drag = {
        kind: "pinch",
        element: drag.element,
        view,
        distance: Math.max(1, Math.abs(a - b)),
        anchor: laneTime(drag.element, (a + b) / 2),
      };
      return;
    }
    if (pointers.size > 1) return;

    const edge = edgeAt(lane!, event.clientX, callbacks.loop());
    if (edge) {
      drag = {
        kind: "edge",
        element: lane!,
        edge,
        loop: callbacks.loop()!,
        moved: false,
        lastX: event.clientX,
        lastEvent: event,
      };
      lane!.setPointerCapture(event.pointerId);
      holdTimelineFollow(true);
      event.preventDefault();
      return;
    }
    drag = {
      kind: "pan",
      element: lane!,
      startX: event.clientX,
      view: timelineView(duration),
      moved: false,
    };
  });

  root.addEventListener("pointermove", (event) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, event.clientX);
    if (!drag) {
      hoverCursor(event, callbacks);
      return;
    }
    const duration = playerTime().duration;
    const width = drag.element.getBoundingClientRect().width || 1;
    switch (drag.kind) {
      case "pan": {
        const dx = event.clientX - drag.startX;
        if (!drag.moved) {
          if (Math.abs(dx) < DRAG_THRESHOLD) return;
          drag.moved = true;
          drag.element.setPointerCapture(event.pointerId);
          holdTimelineFollow(true);
        }
        setTimelineView(panView(drag.view, (-dx / width) * drag.view.span, duration));
        break;
      }
      case "edge":
        drag.moved = true;
        drag.lastX = event.clientX;
        drag.lastEvent = event;
        moveEdge(drag);
        if (!scrollFrame) {
          scrollTime = 0;
          scrollFrame = requestAnimationFrame(scrollWhileHeld);
        }
        break;
      case "overview": {
        if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
        drag.moved = true;
        const view = timelineView(duration);
        const time = overviewTime(drag.element, event.clientX, duration);
        setTimelineView({ start: time - drag.grab, span: view.span });
        break;
      }
      case "pinch": {
        if (pointers.size < 2) return;
        const [a, b] = [...pointers.values()];
        const factor = Math.max(1, Math.abs(a - b)) / drag.distance;
        const rect = drag.element.getBoundingClientRect();
        const fraction = rect.width ? ((a + b) / 2 - rect.left) / rect.width : 0.5;
        const span = drag.view.span / factor;
        // The time first under the fingers stays under them.
        setTimelineView({ start: drag.anchor - fraction * span, span });
        break;
      }
    }
  });

  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (drag?.kind === "pinch" && pointers.size > 0) return;
    end();
  };
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);

  root.addEventListener("wheel", (event) => {
    const target = event.target as HTMLElement;
    const overview = target.closest<HTMLElement>(".overview");
    const lane = overview ? null : target.closest<HTMLElement>(LANES);
    const duration = playerTime().duration;
    if ((!overview && !lane) || !(duration > 0)) return;
    const page = window.innerHeight;
    const dx = wheelPixels(event.deltaX, event.deltaMode, page);
    const dy = wheelPixels(event.deltaY, event.deltaMode, page);
    const view = timelineView(duration);
    const element = (overview ?? lane)!;
    const zoom = overview ? Math.abs(dy) >= Math.abs(dx) : event.ctrlKey || event.metaKey;
    if (zoom) {
      event.preventDefault();
      const anchor = overview
        ? overviewTime(overview, event.clientX, duration)
        : laneTime(element, event.clientX);
      // Over the overview, zoom around the middle of the window when the
      // pointer is outside it, so the view does not jump away.
      const inside = anchor >= view.start && anchor <= view.start + view.span;
      const around = overview && !inside ? viewTime(view, 0.5) : anchor;
      setTimelineView(zoomView(view, wheelZoomFactor(dy), around, duration));
      return;
    }
    // Sideways (or Shift + wheel): move along, when zoomed in.
    const sideways = Math.abs(dx) > Math.abs(dy) ? dx : event.shiftKey ? dy : 0;
    if (!sideways || !isZoomed(view, duration)) return;
    event.preventDefault();
    const width = element.getBoundingClientRect().width || 1;
    const seconds = overview ? (sideways / width) * duration : (sideways / width) * view.span;
    setTimelineView(panView(view, seconds, duration));
  }, { passive: false });
}

/** The track time at `clientX` over the overview (the whole track). */
function overviewTime(overview: HTMLElement, clientX: number, duration: number): number {
  const rect = overview.getBoundingClientRect();
  const fraction = rect.width ? (clientX - rect.left) / rect.width : 0;
  return Math.max(0, Math.min(1, fraction)) * duration;
}

/** Shows a resize cursor over a loop edge, and a grab cursor when zoomed. */
function hoverCursor(event: PointerEvent, callbacks: TimelineCallbacks): void {
  if (event.pointerType !== "mouse") return;
  const lane = (event.target as HTMLElement).closest<HTMLElement>(LANES);
  if (!lane) return;
  lane.classList.toggle("edge-hover", edgeAt(lane, event.clientX, callbacks.loop()) !== null);
}
