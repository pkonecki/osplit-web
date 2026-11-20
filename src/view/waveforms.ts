import { type BeatGrid, barNumber, isDownbeat } from "../analysis/grid";
import { peaksFromChannels } from "../peaks";
import { decodedChannels, playerTime } from "../player";
import { state } from "../state";
import { getPeaks, putPeaks } from "../storage";
import { isZoomed, type TimeView } from "../timeline";
import type { Project, Stem, Track } from "../types";
import { followPlayhead, lanePercent, laneTime, timelineView } from "./timeline";

/**
 * Waveform overviews in the stem rows. Peaks come from the separation (stored
 * with the stems); projects separated before peaks existed get them from the
 * decoded playback buffers, once, and they are saved. With streaming playback
 * such projects show no waveform.
 *
 * The lanes (waveforms, loop ruler, chord lane) show the zoomed view; the
 * overview above them shows the whole track and the part in view.
 */

/** Peaks drawn on the page now, so a resize or re-render can redraw them. */
let shown: Partial<Record<Stem, Float32Array>> = {};
/** The loudest stem at each point, drawn in the overview. */
let overviewPeaks: Float32Array | null = null;
let shownProjectId: string | null = null;
/** The beat grid drawn over the waveforms, and the track length it spans. */
let shownGrid: BeatGrid | null = null;
let gridDuration = 0;

/** A stem row's waveform; `silent` dims it (muted, or another stem soloed). */
export function waveformMarkup(track: Track, silent: boolean): string {
  const lane = track === "click" ? " beat-lane" : "";
  return `<div class="waveform${lane}${silent ? " silent" : ""}" data-action="waveform-seek" data-waveform="${track}" aria-hidden="true"><canvas></canvas><canvas class="grid-canvas"></canvas><span class="loop-band" hidden></span><span class="playhead"></span></div>`;
}

/**
 * The whole track in miniature, with the part in view marked: scroll on it
 * to zoom, drag to move along. Beside it, zoom buttons.
 */
export function overviewMarkup(): string {
  return `
    <div class="timeline-bar">
      <div class="overview" title="Scroll to zoom · drag to move" aria-hidden="true">
        <canvas></canvas>
        <span class="loop-band" hidden></span>
        <span class="overview-window"></span>
        <span class="playhead"></span>
      </div>
      <div class="zoom-buttons" role="group" aria-label="Zoom">
        <button class="step-button" data-action="zoom" data-zoom="out" aria-label="Zoom out">−</button>
        <button class="step-button" data-action="zoom" data-zoom="in" aria-label="Zoom in">+</button>
        <button class="step-button zoom-text" data-action="zoom" data-zoom="fit" aria-label="Show the whole track">All</button>
        <button class="step-button zoom-text" data-action="zoom" data-zoom="loop" aria-label="Zoom to the loop">Loop</button>
      </div>
    </div>
  `;
}

/**
 * Sets the beat grid drawn over the waveforms and in the bar ruler (null to
 * remove it); `duration` is the track length in seconds.
 */
export function setGridOverlay(grid: BeatGrid | null, duration: number): void {
  if (grid === shownGrid && duration === gridDuration) return;
  shownGrid = grid;
  gridDuration = duration;
  drawGrids();
}

/**
 * Draws the waveform of every stem row that has peaks, filling in missing
 * peaks from the decoded playback buffers when the player has them.
 */
export async function showWaveforms(project: Project): Promise<void> {
  // Redraw what is known at once, so re-rendered rows don't change height
  // while the stored peaks are read.
  if (shownProjectId === project.id) drawAll();
  const peaks = await getPeaks(project.id);
  for (const stem of project.completedStems) {
    if (peaks[stem]) continue;
    const channels = decodedChannels(stem);
    if (!channels) continue;
    peaks[stem] = peaksFromChannels(channels[0], channels[1]);
    await putPeaks(project.id, stem, peaks[stem]);
  }
  // The page may have moved on to another project meanwhile.
  if (state.selectedProject?.id !== project.id) return;
  shown = peaks;
  shownProjectId = project.id;
  overviewPeaks = combinedPeaks(Object.values(peaks));
  drawAll();
}

/** The loudest of `all` at each point (they have the same length). */
function combinedPeaks(all: (Float32Array | undefined)[]): Float32Array | null {
  const present = all.filter((peaks): peaks is Float32Array => peaks !== undefined);
  if (!present.length) return null;
  const length = Math.min(...present.map((peaks) => peaks.length));
  const result = new Float32Array(length);
  for (const peaks of present) {
    for (let i = 0; i < length; i++) result[i] = Math.max(result[i], peaks[i]);
  }
  return result;
}

/** Redraws the lanes and the overview (after a resize or a zoom). */
export function drawAll(): void {
  const duration = playerTime().duration;
  const view = timelineView(duration);
  for (const element of document.querySelectorAll<HTMLElement>("[data-waveform]")) {
    const peaks = shown[element.dataset.waveform as Stem];
    if (peaks) draw(element, peaks, view, duration);
  }
  drawGrids();
  drawOverview(view, duration);
  updatePlayheads();
}

function drawOverview(view: TimeView, duration: number): void {
  const overview = document.querySelector<HTMLElement>(".overview");
  if (!overview) {
    document.body.classList.remove("timeline-zoomed");
    return;
  }
  overview.classList.toggle("ready", duration > 0);
  // Lanes show a grab cursor while there is somewhere to move to.
  document.body.classList.toggle("timeline-zoomed", isZoomed(view, duration));
  const box = overview.querySelector<HTMLElement>(".overview-window");
  if (box && duration > 0) {
    box.style.left = `${(view.start / duration) * 100}%`;
    box.style.width = `${(view.span / duration) * 100}%`;
  }
  const canvas = overview.querySelector<HTMLCanvasElement>("canvas");
  if (!canvas) return;
  const context = sizeCanvas(overview, canvas);
  if (!context || !overviewPeaks || shownProjectId !== state.selectedProject?.id || !(duration > 0)) return;
  context.fillStyle = getComputedStyle(overview).color;
  drawPeaks(context, overviewPeaks, fullViewOf(duration), duration);
}

function fullViewOf(duration: number): TimeView {
  return { start: 0, span: duration };
}

/** Draws the beat grid on every waveform, the click lane and the ruler. */
function drawGrids(): void {
  for (const element of document.querySelectorAll<HTMLElement>(".waveform, .loop-ruler")) {
    const canvas = element.querySelector<HTMLCanvasElement>("canvas.grid-canvas");
    if (!canvas) continue;
    const lane = element.classList.contains("beat-lane");
    // The click lane shows only once there is a grid to show.
    if (lane) element.classList.toggle("drawn", shownGrid !== null);
    const context = sizeCanvas(element, canvas);
    if (!context || !shownGrid || !(gridDuration > 0)) continue;
    drawGrid(
      context,
      shownGrid,
      timelineView(playerTime().duration || gridDuration),
      lane ? "lane" : element.classList.contains("loop-ruler") ? "ruler" : "overlay",
    );
  }
}

function sizeCanvas(
  element: HTMLElement,
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(element.clientWidth * ratio);
  const height = Math.round(element.clientHeight * ratio);
  if (!width || !height) return null;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, width, height);
  return context;
}

/** Beat lines closer than this (CSS pixels) are left out; downbeats stay. */
const MIN_BEAT_SPACING = 3;
/** Bar numbers closer than this (CSS pixels) are thinned out. */
const MIN_LABEL_SPACING = 30;

function drawGrid(
  context: CanvasRenderingContext2D,
  grid: BeatGrid,
  view: TimeView,
  style: "overlay" | "ruler" | "lane",
): void {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = context.canvas;
  if (!(view.span > 0)) return;
  const pixelsPerSecond = width / ratio / view.span;
  const showBeats = (60 / grid.bpm) * pixelsPerSecond >= MIN_BEAT_SPACING;
  const barPixels = (60 / grid.bpm) * grid.beatsPerBar * pixelsPerSecond;
  let labelEvery = 1;
  while (barPixels * labelEvery < MIN_LABEL_SPACING) labelEvery *= 2;
  const line = Math.max(1, Math.round(ratio));
  context.font = `${10 * ratio}px system-ui, sans-serif`;
  context.textBaseline = "top";
  const end = view.start + view.span;
  grid.beats.forEach((time, index) => {
    if (time < view.start - 1 || time > end) return;
    const downbeat = isDownbeat(grid, index);
    if (!downbeat && !showBeats) return;
    const x = Math.round(((time - view.start) / view.span) * width);
    if (style === "overlay") {
      context.fillStyle = downbeat ? "rgba(240, 241, 233, .28)" : "rgba(240, 241, 233, .1)";
      context.fillRect(x, 0, line, height);
    } else if (style === "lane") {
      context.fillStyle = downbeat ? "rgba(183, 243, 107, .9)" : "rgba(183, 243, 107, .45)";
      const tick = downbeat ? height * 0.8 : height * 0.45;
      context.fillRect(x, (height - tick) / 2, line * 2, tick);
    } else {
      context.fillStyle = downbeat ? "rgba(240, 241, 233, .45)" : "rgba(240, 241, 233, .18)";
      const tick = downbeat ? height : height * 0.3;
      context.fillRect(x, height - tick, line, tick);
      const bar = barNumber(grid, index);
      if (downbeat && bar >= 1 && (bar - 1) % labelEvery === 0) {
        context.fillStyle = "rgba(240, 241, 233, .7)";
        context.fillText(String(bar), x + 3 * ratio, 2 * ratio);
      }
    }
  });
}

function draw(element: HTMLElement, peaks: Float32Array, view: TimeView, duration: number): void {
  element.classList.add("drawn");
  const canvas = element.querySelector<HTMLCanvasElement>("canvas:not(.grid-canvas)")!;
  const context = sizeCanvas(element, canvas);
  if (!context || !(duration > 0)) return;
  context.fillStyle = getComputedStyle(element).color;
  drawPeaks(context, peaks, view, duration);
}

/** Draws the part of `peaks` (spanning `duration`) that `view` shows. */
function drawPeaks(
  context: CanvasRenderingContext2D,
  peaks: Float32Array,
  view: TimeView,
  duration: number,
): void {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = context.canvas;
  const middle = height / 2;
  const bar = Math.max(1, Math.floor(ratio));
  const bucketsPerPixel = (view.span / duration) * peaks.length / width;
  const first = (view.start / duration) * peaks.length;
  for (let x = 0; x < width; x += bar) {
    // The loudest peak over the buckets this column covers.
    const from = Math.floor(first + x * bucketsPerPixel);
    const to = Math.max(from + 1, Math.floor(first + (x + bar) * bucketsPerPixel));
    let level = 0;
    for (let i = Math.max(0, from); i < to && i < peaks.length; i++) {
      level = Math.max(level, peaks[i]);
    }
    const half = Math.max(ratio / 2, level * middle);
    context.fillRect(x, middle - half, bar, half * 2);
  }
}

/**
 * Moves the playheads to the player position (called on every tick, and
 * every frame while playing), moving the view along when the playhead
 * leaves it.
 */
export function updatePlayheads(): void {
  followPlayhead();
  const { position, duration } = playerTime();
  const lane = `${duration ? lanePercent(position, duration) : 0}%`;
  for (
    const head of document.querySelectorAll<HTMLElement>(
      ".waveform .playhead, .loop-ruler .playhead, .chord-lane .playhead",
    )
  ) {
    head.style.left = lane;
  }
  const overview = document.querySelector<HTMLElement>(".overview .playhead");
  if (overview) overview.style.left = `${duration ? (position / duration) * 100 : 0}%`;
}

let playheadFrame = 0;

/** Keeps the playheads smooth while playing (the player ticks 4 times a second). */
export function followPlayheads(): void {
  if (playheadFrame || !playerTime().playing) return;
  const step = () => {
    playheadFrame = 0;
    if (!playerTime().playing) return;
    updatePlayheads();
    playheadFrame = requestAnimationFrame(step);
  };
  playheadFrame = requestAnimationFrame(step);
}

/** The track position (seconds) at `clientX` over a lane, in the current view. */
export function waveformSeekTime(element: HTMLElement, clientX: number): number {
  return laneTime(element, clientX);
}

let resizeFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(drawAll);
});
