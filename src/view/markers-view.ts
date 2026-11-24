import { MARKER_PRESETS, MAX_MARKER_NAME, sectionBars } from "../markers";
import { playerTime } from "../player";
import type { Project } from "../types";
import { currentBar, sectionLooped, shownBars } from "./chart";
import { escapeHtml, formatTime } from "./format";
import { icon } from "./icons";
import { openPanel } from "./panels";

/**
 * Markers beside the chart: a column on desktop, a strip that scrolls
 * sideways on a phone. Each jumps to its section; on desktop each also
 * loops it. The Add marker panel opens from the + button (or M).
 */

export function markersMarkup(): string {
  return `
    <nav class="markers popover-anchor" id="markers" aria-label="Markers">
      <div class="markers-head">
        <span class="markers-title">Markers</span>
        <button class="markers-add" data-action="panel" data-panel="marker" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel-marker" title="Add a marker at the playhead (M)" aria-label="Add marker">${
    icon("plus", 16)
  }<span>Add</span></button>
      </div>
      <div class="markers-list" id="markers-list"></div>
      ${markerPanelMarkup()}
    </nav>`;
}

function markerPanelMarkup(): string {
  return `<div class="panel panel-marker" id="panel-marker" role="dialog" aria-labelledby="panel-marker-title" ${
    openPanel() === "marker" ? "" : "hidden"
  }>
      <div class="panel-head"><h2 id="panel-marker-title">Add marker</h2><button class="icon-button panel-close" data-action="panel-close" aria-label="Close">${
    icon("close", 18)
  }</button></div>
      <div class="panel-box">
        <div class="box-row">
          <span class="box-label"><small class="muted">Starts at</small><br /><output id="marker-start" class="marker-start">—</output></span>
          <button class="step-button" data-action="marker-bar" data-step="-1" aria-label="One bar earlier">‹</button>
          <button class="step-button" data-action="marker-bar" data-step="1" aria-label="One bar later">›</button>
        </div>
      </div>
      <div class="field-group">
        <label for="marker-name" class="box-label">Name</label>
        <input id="marker-name" class="text-input" type="text" maxlength="${MAX_MARKER_NAME}" placeholder="e.g. Chorus 2" autocomplete="off" />
        <div class="preset-grid cols-4">${
    MARKER_PRESETS.map((name) => `<button class="preset" data-action="marker-preset" data-name="${name}">${name}</button>`).join("")
  }</div>
      </div>
      <div class="panel-actions">
        <button class="button subtle" data-action="panel-close">Cancel</button>
        <button class="button primary" data-action="marker-save">Save</button>
      </div>
    </div>`;
}

let listKey = "";

/** Rebuilds the markers list when the markers, the loop or the bars change. */
export function updateMarkersView(project: Project): void {
  const list = document.querySelector<HTMLElement>("#markers-list");
  if (!list) return;
  const bars = shownBars();
  const markers = project.markers ?? [];
  const key = JSON.stringify([project.id, markers, project.loop, bars.length, bars[0]?.start]);
  const add = document.querySelector<HTMLButtonElement>(".markers-add");
  if (add) {
    add.disabled = bars.length === 0;
    add.title = bars.length ? "Add a marker at the playhead (M)" : "Markers need the song's bars: they appear once the beats are found";
  }
  if (key === listKey && list.childElementCount) return;
  listKey = key;
  if (!markers.length) {
    list.innerHTML = `<p class="markers-empty muted">${
      bars.length ? "Mark the intro, verses, chorus… to jump to them and loop them." : "Markers need the song's bars."
    }</p>`;
    return;
  }
  const lastBar = bars[bars.length - 1]?.number ?? markers[markers.length - 1].bar;
  list.innerHTML = markers.map((marker, index) => {
    const { first, last } = sectionBars(markers, index, lastBar);
    const start = bars.find((bar) => bar.number === marker.bar)?.start ?? marker.time;
    const looped = sectionLooped(project, index, bars);
    const name = escapeHtml(marker.name);
    return `<div class="marker-item" data-marker-bar="${marker.bar}">
        <button class="marker-jump" data-action="marker-jump" data-bar="${marker.bar}" aria-label="Jump to ${name}">
          <span class="marker-name">${name}</span>
          <span class="marker-meta">${first === last ? `Bar ${first}` : `Bars ${first}–${last}`} · ${formatTime(start)}</span>
        </button>
        <button class="marker-loop${looped ? " on" : ""}" data-action="marker-loop" data-bar="${marker.bar}" aria-pressed="${looped}" aria-label="Loop ${name}" title="Loop this section">${
      icon("loop", 16)
    }</button>
      </div>`;
  }).join("");
  updateCurrentMarker(project);
}

/** Marks the marker whose section is playing. */
export function updateCurrentMarker(project: Project): void {
  const markers = project.markers ?? [];
  const bar = currentBar();
  let current = -1;
  if (bar) for (const marker of markers) if (marker.bar <= bar.number) current = marker.bar;
  for (const item of document.querySelectorAll<HTMLElement>(".marker-item")) {
    item.classList.toggle("current", Number(item.dataset.markerBar) === current);
  }
}

/** The bar the Add marker panel will use, chosen when it opens. */
let pendingBar = 0;

/** Prepares the Add marker panel: the bar at the playhead, an empty name. */
export function prepareMarkerPanel(): void {
  const bar = currentBar() ?? shownBars().find((item) => item.end > playerTime().position) ?? shownBars()[0];
  pendingBar = bar?.number ?? 1;
  const input = document.querySelector<HTMLInputElement>("#marker-name");
  if (input) input.value = "";
  showPendingBar();
}

export function stepPendingBar(step: number): void {
  const bars = shownBars();
  if (!bars.length) return;
  const index = bars.findIndex((bar) => bar.number === pendingBar);
  pendingBar = bars[Math.max(0, Math.min(bars.length - 1, index + step))].number;
  showPendingBar();
}

export function pendingMarkerBar(): number {
  return pendingBar;
}

function showPendingBar(): void {
  const bar = shownBars().find((item) => item.number === pendingBar);
  const output = document.querySelector<HTMLElement>("#marker-start");
  if (output) output.textContent = bar ? `Bar ${bar.number} · ${formatTime(bar.start)}` : "—";
}

/** Marker ticks on the seek bar. */
export function updateScrubMarkers(project: Project): void {
  const track = document.querySelector<HTMLElement>(".scrub-track");
  const { duration } = playerTime();
  if (!track) return;
  track.querySelectorAll(".scrub-tick").forEach((tick) => tick.remove());
  if (!(duration > 0)) return;
  const bars = shownBars();
  for (const marker of project.markers ?? []) {
    const start = bars.find((bar) => bar.number === marker.bar)?.start ?? marker.time;
    const tick = document.createElement("span");
    tick.className = "scrub-tick";
    tick.style.left = `${(start / duration) * 100}%`;
    tick.title = marker.name;
    track.append(tick);
  }
}
