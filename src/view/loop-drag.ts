import { MIN_LOOP_SECONDS, normalizeLoop } from "../practice";
import type { ProjectLoop } from "../types";
import { waveformSeekTime } from "./waveforms";

/**
 * Pointer gestures for the loop: dragging across a waveform or the loop
 * ruler draws a new loop, and dragging a handle moves that edge. A press
 * without movement stays a click (which seeks). Works the same for mouse,
 * pen and touch. Positions snap to the beat grid when there is one.
 */

export interface LoopDragCallbacks {
  loop(): ProjectLoop | undefined;
  duration(): number;
  /** Shows and plays a loop while dragging, without saving it. */
  preview(loop: ProjectLoop): void;
  /** The drag ended on `loop`: save it. */
  commit(loop: ProjectLoop): void;
  /** Moves a dragged position onto the beat grid (modifier keys may opt out). */
  snap(seconds: number, event: PointerEvent): number;
}

/** Movement (CSS pixels) that turns a press into a drag. */
const DRAG_THRESHOLD = 4;

type Drag =
  | { kind: "create"; element: HTMLElement; anchor: number; startX: number; moved: boolean }
  | { kind: "handle"; element: HTMLElement; edge: "start" | "end"; moved: boolean };

let suppressClick = false;

/** True once after a drag, so the click that follows it doesn't seek. */
export function takeSuppressedClick(): boolean {
  const suppressed = suppressClick;
  suppressClick = false;
  return suppressed;
}

export function installLoopDrag(root: HTMLElement, callbacks: LoopDragCallbacks): void {
  let drag: Drag | null = null;
  let current: ProjectLoop | undefined;

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || callbacks.duration() <= 0) return;
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>("[data-loop-handle]");
    const area = target.closest<HTMLElement>(".loop-ruler, .waveform");
    if (!area) return;
    suppressClick = false;
    current = callbacks.loop();
    if (handle && current) {
      drag = {
        kind: "handle",
        element: area,
        edge: handle.dataset.loopHandle === "start" ? "start" : "end",
        moved: false,
      };
      area.setPointerCapture(event.pointerId);
      event.preventDefault();
    } else {
      drag = {
        kind: "create",
        element: area,
        anchor: callbacks.snap(waveformSeekTime(area, event.clientX), event),
        startX: event.clientX,
        moved: false,
      };
    }
  });

  root.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const duration = callbacks.duration();
    const raw = waveformSeekTime(drag.element, event.clientX);
    const snapped = callbacks.snap(raw, event);
    if (drag.kind === "create") {
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
        drag.moved = true;
        drag.element.setPointerCapture(event.pointerId);
      }
      // Both ends on the same grid line: follow the pointer instead.
      const time = Math.abs(snapped - drag.anchor) < MIN_LOOP_SECONDS ? raw : snapped;
      const region = normalizeLoop(drag.anchor, time, duration);
      if (!region) return;
      current = { ...region, enabled: true };
    } else {
      if (!current) return;
      drag.moved = true;
      const time = snapped;
      const start = drag.edge === "start"
        ? Math.min(time, current.end - MIN_LOOP_SECONDS)
        : current.start;
      const end = drag.edge === "end"
        ? Math.max(time, current.start + MIN_LOOP_SECONDS)
        : current.end;
      const region = normalizeLoop(start, end, duration);
      if (!region) return;
      current = { ...current, ...region };
    }
    callbacks.preview(current);
  });

  const finish = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved && current) {
      suppressClick = true;
      callbacks.commit(current);
    }
  };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", finish);
}
