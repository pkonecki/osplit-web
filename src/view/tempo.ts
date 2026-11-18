import {
  formatTempo,
  LOW_CONFIDENCE,
  MAX_BPM_FACTOR,
  MIN_BPM_FACTOR,
} from "../analysis/grid";
import { projectSpeed } from "../practice";
import { analysisStatus, cachedAnalysis, projectGrid } from "../tasks/analysis";
import type { Project } from "../types";
import { escapeHtml } from "./format";

/**
 * The tempo chip in the practice bar and the panel it opens, where the user
 * corrects the detected grid. Updated in place as the analysis runs.
 */

let panelOpen = false;

export function tempoPanelOpen(): boolean {
  return panelOpen;
}

export function setTempoPanelOpen(open: boolean): void {
  panelOpen = open;
}

export function tempoChipMarkup(): string {
  return `
    <div class="practice-group tempo-group" role="group" aria-label="Tempo">
      <span class="practice-label">Tempo</span>
      <button class="tempo-chip" id="tempo-chip" data-action="tempo-panel" aria-controls="tempo-panel" aria-expanded="false">…</button>
    </div>
  `;
}

export function tempoPanelMarkup(): string {
  return `
    <div class="tempo-panel" id="tempo-panel" ${panelOpen ? "" : "hidden"}>
      <p class="tempo-status" id="tempo-status" aria-live="polite"></p>
      <div class="tempo-actions">
        <div class="practice-group" role="group" aria-label="Tempo correction">
          <button class="step-button" data-action="tempo-factor" data-factor="0.5" aria-label="Half the tempo">÷2</button>
          <button class="step-button" data-action="tempo-factor" data-factor="2" aria-label="Double the tempo">×2</button>
        </div>
        <div class="practice-group" role="group" aria-label="Beats per bar">
          <span class="practice-label">Beats/bar</span>
          <button class="step-button" data-action="tempo-metre" data-beats="3" aria-pressed="false">3</button>
          <button class="step-button" data-action="tempo-metre" data-beats="4" aria-pressed="false">4</button>
        </div>
        <div class="practice-group" role="group" aria-label="Downbeat">
          <span class="practice-label">Downbeat</span>
          <button class="step-button" data-action="tempo-downbeat" data-step="-1" aria-label="Bars start a beat earlier">◀</button>
          <button class="step-button" data-action="tempo-downbeat" data-step="1" aria-label="Bars start a beat later">▶</button>
        </div>
        <button class="step-button tap-button" data-action="tempo-tap" title="Tap on each beat (T)">Tap tempo</button>
        <button class="button text-button" data-action="tempo-reset">Undo corrections</button>
        <button class="button text-button" data-action="analyze">Re-analyze</button>
      </div>
    </div>
  `;
}

/** Updates the chip and panel for `project`, in place. */
export function updateTempoDisplay(project: Project): void {
  const chip = document.querySelector<HTMLButtonElement>("#tempo-chip");
  if (!chip) return;
  const status = analysisStatus(project.id);
  const record = cachedAnalysis(project.id);
  const grid = projectGrid(project.id);
  let text: string;
  let action = "tempo-panel";
  if (status.running) {
    text = `Analyzing… ${status.progress}%`;
  } else if (grid) {
    const low = grid.confidence < LOW_CONFIDENCE ? "?" : "";
    text = `♩ ${formatTempo(grid.bpm, projectSpeed(project))}${low} BPM`;
  } else if (record === undefined) {
    text = "…";
  } else {
    // No analysis yet, it failed, or found no beats.
    text = status.error ? "Retry tempo" : record ? "No beat found" : "Find tempo";
    action = record ? "tempo-panel" : "analyze";
  }
  if (chip.textContent !== text) chip.textContent = text;
  chip.dataset.action = action;
  chip.title = status.error ?? "";
  chip.setAttribute("aria-expanded", String(panelOpen && action === "tempo-panel"));
  chip.disabled = status.running;

  const panel = document.querySelector<HTMLElement>("#tempo-panel");
  if (!panel) return;
  panel.hidden = !panelOpen || !record;
  const edits = record?.edits ?? {};
  const factor = edits.bpmFactor ?? 1;
  setDisabled('[data-action="tempo-factor"][data-factor="0.5"]', !grid || factor <= MIN_BPM_FACTOR);
  setDisabled('[data-action="tempo-factor"][data-factor="2"]', !grid || factor >= MAX_BPM_FACTOR);
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-action="tempo-metre"]')) {
    const pressed = grid?.beatsPerBar === Number(button.dataset.beats);
    button.setAttribute("aria-pressed", String(pressed));
    button.classList.toggle("on", pressed);
    button.disabled = !grid;
  }
  setDisabled('[data-action="tempo-downbeat"][data-step="-1"]', !grid);
  setDisabled('[data-action="tempo-downbeat"][data-step="1"]', !grid);
  setDisabled('[data-action="tempo-reset"]', Object.keys(edits).length === 0);
  const statusText = panel.querySelector<HTMLElement>("#tempo-status");
  if (statusText) statusText.innerHTML = statusMarkup(project);
}

function statusMarkup(project: Project): string {
  const record = cachedAnalysis(project.id);
  const grid = projectGrid(project.id);
  if (!record) return "";
  if (!grid) return "No steady beat was found. Tap the tempo while the track plays.";
  const parts: string[] = [];
  if (record.edits?.tapped) {
    parts.push(`Tapped at ${record.edits.tapped.bpm} BPM.`);
  } else {
    parts.push(
      `Detected ${Math.round(record.bpm)} BPM in the ${
        record.source === "drums" ? "drums" : "full mix"
      }.`,
    );
    if (record.alternativeBpm) {
      parts.push(`It may also be ${Math.round(record.alternativeBpm)} BPM.`);
    }
  }
  const warning = grid.confidence < LOW_CONFIDENCE
    ? `<strong>Low confidence — check the grid.</strong> Loops don't snap to it. `
    : "";
  return `${warning}${escapeHtml(parts.join(" "))}`;
}

function setDisabled(selector: string, disabled: boolean): void {
  const element = document.querySelector<HTMLButtonElement>(selector);
  if (element) element.disabled = disabled;
}
