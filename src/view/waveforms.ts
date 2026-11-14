import { peaksFromChannels } from "../peaks";
import { decodedChannels, playerTime } from "../player";
import { state } from "../state";
import { getPeaks, putPeaks } from "../storage";
import type { Project, Stem } from "../types";

/**
 * Waveform overviews in the stem rows. Peaks come from the separation (stored
 * with the stems); projects separated before peaks existed get them from the
 * decoded playback buffers, once, and they are saved. With streaming playback
 * such projects show no waveform.
 */

/** Peaks drawn on the page now, so a resize or re-render can redraw them. */
let shown: Partial<Record<Stem, Float32Array>> = {};
let shownProjectId: string | null = null;

/** A stem row's waveform; `silent` dims it (muted, or another stem soloed). */
export function waveformMarkup(stem: Stem, silent: boolean): string {
  return `<div class="waveform${silent ? " silent" : ""}" data-action="waveform-seek" data-waveform="${stem}" aria-hidden="true"><canvas></canvas><span class="playhead"></span></div>`;
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
  updatePlayheads();
}

function draw(element: HTMLElement, peaks: Float32Array): void {
  element.classList.add("drawn");
  const canvas = element.querySelector("canvas")!;
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
  for (const head of document.querySelectorAll<HTMLElement>(".waveform .playhead")) {
    head.style.left = `${percent}%`;
  }
}

/** The track position (seconds) at a click on a waveform. */
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
