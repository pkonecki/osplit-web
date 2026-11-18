import { type BeatGrid, barNumber, isDownbeat } from "../analysis/grid";
import { peaksFromChannels } from "../peaks";
import { decodedChannels, playerTime } from "../player";
import { state } from "../state";
import { getPeaks, putPeaks } from "../storage";
import type { Project, Stem, Track } from "../types";

/**
 * Waveform overviews in the stem rows. Peaks come from the separation (stored
 * with the stems); projects separated before peaks existed get them from the
 * decoded playback buffers, once, and they are saved. With streaming playback
 * such projects show no waveform.
 */

/** Peaks drawn on the page now, so a resize or re-render can redraw them. */
let shown: Partial<Record<Stem, Float32Array>> = {};
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
  drawAll();
}

function drawAll(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-waveform]")) {
    const peaks = shown[element.dataset.waveform as Stem];
    if (peaks) draw(element, peaks);
  }
  drawGrids();
  updatePlayheads();
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
      gridDuration,
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
  duration: number,
  style: "overlay" | "ruler" | "lane",
): void {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = context.canvas;
  const pixelsPerSecond = width / ratio / duration;
  const showBeats = (60 / grid.bpm) * pixelsPerSecond >= MIN_BEAT_SPACING;
  const barPixels = (60 / grid.bpm) * grid.beatsPerBar * pixelsPerSecond;
  let labelEvery = 1;
  while (barPixels * labelEvery < MIN_LABEL_SPACING) labelEvery *= 2;
  const line = Math.max(1, Math.round(ratio));
  context.font = `${10 * ratio}px system-ui, sans-serif`;
  context.textBaseline = "top";
  grid.beats.forEach((time, index) => {
    if (time < 0 || time > duration) return;
    const downbeat = isDownbeat(grid, index);
    if (!downbeat && !showBeats) return;
    const x = Math.round((time / duration) * width);
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

function draw(element: HTMLElement, peaks: Float32Array): void {
  element.classList.add("drawn");
  const canvas = element.querySelector<HTMLCanvasElement>("canvas:not(.grid-canvas)")!;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(element.clientWidth * ratio);
  const height = Math.round(element.clientHeight * ratio);
  if (!width || !height) return;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  context.fillStyle = getComputedStyle(element).color;
  const middle = height / 2;
  const bar = Math.max(1, Math.floor(ratio));
  for (let x = 0; x < width; x += bar) {
    // The loudest peak over the buckets this column covers.
    const from = Math.floor((x * peaks.length) / width);
    const to = Math.max(from + 1, Math.floor(((x + bar) * peaks.length) / width));
    let level = 0;
    for (let i = from; i < to && i < peaks.length; i++) {
      level = Math.max(level, peaks[i]);
    }
    const half = Math.max(ratio / 2, level * middle);
    context.fillRect(x, middle - half, bar, half * 2);
  }
}

/** Moves the playheads to the player position (called on every tick). */
export function updatePlayheads(): void {
  const { position, duration } = playerTime();
  const percent = duration ? (position / duration) * 100 : 0;
  for (
    const head of document.querySelectorAll<HTMLElement>(
      ".waveform .playhead, .loop-ruler .playhead",
    )
  ) {
    head.style.left = `${percent}%`;
  }
}

/** The track position (seconds) at `clientX` over a waveform or the loop ruler. */
export function waveformSeekTime(element: HTMLElement, clientX: number): number {
  const rect = element.getBoundingClientRect();
  const fraction = rect.width ? (clientX - rect.left) / rect.width : 0;
  return Math.max(0, Math.min(1, fraction)) * playerTime().duration;
}

let resizeFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(drawAll);
});
