import { exportAppliesPractice, exportFormat } from "../export";
import { formatTempo, LOW_CONFIDENCE, loopBars, MAX_BPM_FACTOR, MIN_BPM_FACTOR } from "../analysis/grid";
import { KEY_UNCLEAR } from "../analysis/key";
import { ALL_KEYS, keyName, sameKey, transposeKey } from "../analysis/spelling";
import {
  formatPrecise,
  formatSemitones,
  formatSpeed,
  isNeutral,
  MAX_SEMITONES,
  MAX_SPEED,
  MIN_SEMITONES,
  MIN_SPEED,
  projectSemitones,
  projectSpeed,
} from "../practice";
import { analysisStatus, cachedAnalysis, projectGrid } from "../tasks/analysis";
import {
  ALL_STEMS,
  type AnalysisRecord,
  DEFAULT_CLICK_VOLUME,
  type Project,
  STEM_LABELS,
} from "../types";
import { escapeHtml, formatTime } from "./format";
import { songKey } from "./harmony";
import { icon } from "./icons";

/**
 * The practice panels: Speed, Key, Loop, Rhythm and Export. One markup for
 * both layouts: popovers beside their buttons on desktop, bottom sheets on
 * phones (see style.css). One panel is open at a time; values update in
 * place, so a slider being dragged keeps working.
 */

export type PanelName = "speed" | "key" | "loop" | "rhythm" | "export" | "marker";
const PANELS: PanelName[] = ["speed", "key", "loop", "rhythm", "export", "marker"];

let open: PanelName | null = null;

export function openPanel(): PanelName | null {
  return open;
}

/** Opens `name` (or closes every panel with null), in place. */
export function setPanel(name: PanelName | null): void {
  open = name;
  for (const panel of PANELS) {
    const element = document.querySelector<HTMLElement>(`#panel-${panel}`);
    if (element) element.hidden = panel !== name;
    for (const opener of document.querySelectorAll<HTMLElement>(`[data-action="panel"][data-panel="${panel}"]`)) {
      opener.setAttribute("aria-expanded", String(panel === name));
    }
  }
  const backdrop = document.querySelector<HTMLElement>(".panel-backdrop");
  if (backdrop) backdrop.hidden = name === null;
  document.body.classList.toggle("panel-open", name !== null);
}

export function isPanelName(value: string | undefined): value is PanelName {
  return PANELS.includes(value as PanelName);
}

function panel(name: PanelName, title: string, body: string, head = ""): string {
  return `<div class="panel panel-${name}" id="panel-${name}" role="dialog" aria-labelledby="panel-${name}-title" ${
    open === name ? "" : "hidden"
  }>
      <div class="panel-head"><h2 id="panel-${name}-title">${title}</h2>${head}<button class="icon-button panel-close" data-action="panel-close" aria-label="Close">${
    icon("close", 18)
  }</button></div>
      ${body}
    </div>`;
}

/** A chip that opens a panel: label and value. */
export function panelChip(name: PanelName, label: string, valueId: string, extra = ""): string {
  return `<button class="chip practice-chip" data-action="panel" data-panel="${name}" aria-haspopup="dialog" aria-expanded="${
    open === name
  }" aria-controls="panel-${name}" ${extra}><span class="chip-label">${label}</span><span class="chip-value" id="${valueId}"></span></button>`;
}

const SPEED_PRESETS = [0.5, 0.7, 0.85, 1, 1.25];

export function speedPanel(project: Project): string {
  const speed = projectSpeed(project);
  return panel(
    "speed",
    "Speed",
    `
      <div class="panel-big"><output id="speed-value" class="big-value">${formatSpeed(speed)}</output><span id="speed-bpm" class="muted"></span></div>
      <div class="slider-row">
        <button class="step-button" data-action="speed-step" data-step="-1" aria-label="Slower (−5%)">−</button>
        <input id="speed" type="range" min="${MIN_SPEED * 100}" max="${MAX_SPEED * 100}" step="1" value="${
      Math.round(speed * 100)
    }" data-action="speed" aria-label="Speed" aria-valuetext="${formatSpeed(speed)}" />
        <button class="step-button" data-action="speed-step" data-step="1" aria-label="Faster (+5%)">+</button>
      </div>
      <div class="preset-grid cols-5" role="group" aria-label="Speed presets">${
      SPEED_PRESETS.map((value) =>
        `<button class="preset" data-action="speed-preset" data-speed="${value}" aria-pressed="false">${
          Math.round(value * 100)
        }%</button>`
      ).join("")
    }</div>
      <p class="panel-note">The key stays the same at any speed. The click and the loop follow the new tempo.</p>`,
    `<button class="text-action" data-action="speed-reset">Reset</button>`,
  );
}

export function keyPanel(): string {
  return panel(
    "key",
    "Key",
    `
      <div class="panel-box">
        <div class="box-row"><label for="key-select" class="box-label">Song key</label>
          <select id="key-select" data-action="key-select">
            <option value="">Detected</option>
            ${ALL_KEYS.map((key) => `<option value="${key.tonic}:${key.mode}">${keyName(key)}</option>`).join("")}
          </select>
        </div>
        <div class="box-row small"><span id="key-status" class="muted" aria-live="polite"></span><button class="button small" data-action="key-alternative" id="key-alternative" hidden></button></div>
      </div>
      <div class="stepper">
        <button class="step-button big" data-action="key-step" data-step="-1" aria-label="Key down a semitone">−</button>
        <div class="stepper-value" aria-live="polite"><output id="key-value" class="big-value"></output><span id="key-unit" class="muted"></span></div>
        <button class="step-button big" data-action="key-step" data-step="1" aria-label="Key up a semitone">+</button>
      </div>
      <div class="preset-grid cols-6" id="key-grid" role="group" aria-label="Shift the key"></div>
      <label class="switch-row compact">
        <span><strong>Show chords in the new key</strong><small>Off: keep the original chord names</small></span>
        <input type="checkbox" role="switch" class="switch" data-action="chord-names" id="chord-names" />
      </label>`,
    `<button class="text-action" data-action="key-reset">Reset</button>`,
  );
}

export function loopPanel(): string {
  return panel(
    "loop",
    "Loop",
    `
      <div class="panel-box">
        <div class="box-row"><span class="box-label">Loop</span><output id="loop-value">Off</output>
          <button class="button small loop-switch" data-action="loop-toggle" aria-pressed="false">On</button></div>
      </div>
      <div class="ab-row">
        <button class="button secondary" data-action="loop-set" data-edge="start">Set A at the playhead</button>
        <button class="button secondary" data-action="loop-set" data-edge="end">Set B at the playhead</button>
      </div>
      <div class="field-group"><span class="box-label">Loop bars from the playhead</span>
        <div class="preset-grid cols-4" role="group" aria-label="Loop bars from the playhead">${
      [1, 2, 4, 8].map((bars) =>
        `<button class="preset" data-action="loop-bars" data-bars="${bars}" aria-label="Loop ${bars} bar${
          bars > 1 ? "s" : ""
        } from the playhead">${bars}</button>`
      ).join("")
    }</div>
      </div>
      <p class="panel-note">Shift-click a bar in the chart to loop up to it. L turns the loop on or off.</p>`,
    `<button class="text-action" data-action="loop-clear">Clear</button>`,
  );
}

export function rhythmPanel(project: Project): string {
  const on = project.clickOn === true;
  const volume = project.clickVolume ?? DEFAULT_CLICK_VOLUME;
  return panel(
    "rhythm",
    "Rhythm",
    `
      <div class="panel-box">
        <label class="switch-row compact">
          <span><strong>Click</strong><small id="click-note">Follows the beat grid</small></span>
          <input type="checkbox" role="switch" class="switch" data-action="click-toggle" ${on ? "checked" : ""} />
        </label>
        <div class="slider-row">${icon("volume", 18)}
          <input type="range" min="0" max="1" step="0.01" value="${volume}" data-action="volume" data-stem="click" aria-label="Click volume" />
          <span class="slider-value" data-volume-label="click">${Math.round(volume * 100)}%</span>
        </div>
      </div>
      <div class="field-group">
        <div class="field-row"><strong>Tempo</strong><span id="tempo-status" class="muted" aria-live="polite"></span></div>
        <div class="tempo-row">
          <span id="tempo-bpm" class="mid-value">—</span><span class="muted tempo-unit">BPM</span>
          <button class="step-button wide" data-action="tempo-factor" data-factor="0.5" aria-label="Half the tempo">÷2</button>
          <button class="step-button wide" data-action="tempo-factor" data-factor="2" aria-label="Double the tempo">×2</button>
          <button class="step-button wide accent" data-action="tempo-tap" title="Tap on each beat">Tap</button>
        </div>
        <div class="field-row">
          <button class="text-action" data-action="tempo-reset">Use detected tempo</button>
          <button class="text-action" data-action="analyze">Detect again</button>
        </div>
      </div>
      <div class="field-group">
        <div class="field-row"><strong>Beats per measure</strong><span id="metre-detected" class="muted"></span></div>
        <div class="preset-grid cols-6" role="group" aria-label="Beats per measure">
          <button class="preset" data-action="tempo-metre" data-beats="3" aria-pressed="false">3/4</button>
          <button class="preset" data-action="tempo-metre" data-beats="4" aria-pressed="false">4/4</button>
        </div>
      </div>
      <div class="field-row bar-start">
        <span><strong>Bar 1 starts</strong><small id="downbeat-label" class="muted"></small></span>
        <button class="step-button" data-action="tempo-downbeat" data-step="-1" aria-label="Bars start a beat earlier">‹</button>
        <button class="step-button" data-action="tempo-downbeat" data-step="1" aria-label="Bars start a beat later">›</button>
      </div>`,
  );
}

export function exportPanel(project: Project): string {
  const format = exportFormat();
  const stems = ALL_STEMS.filter((stem) => project.completedStems.includes(stem));
  return panel(
    "export",
    "Export",
    `
      <div class="field-group">
        <span class="box-label">Mix</span>
        <button class="export-item" data-action="export-mix"><strong>What you hear</strong><small>The stems as mixed now, in one file</small></button>
        <label class="switch-row compact export-practice" ${isNeutral(project) ? "hidden" : ""}>
          <span><strong>With speed, key &amp; loop</strong><small>Applies the practice settings to the mix</small></span>
          <input type="checkbox" role="switch" class="switch" data-action="export-practice" ${
      exportAppliesPractice() ? "checked" : ""
    } />
        </label>
      </div>
      <div class="field-group">
        <span class="box-label">Stems</span>
        <div class="stem-export-grid">${
      stems.map((stem) =>
        `<button class="export-stem stem-${stem}" data-action="export-stem" data-stem="${stem}" aria-label="Export ${
          STEM_LABELS[stem]
        }">${STEM_LABELS[stem]}</button>`
      ).join("")
    }</div>
        <button class="export-item" data-action="export-all"><strong>All stems</strong><small>${stems.length} files in a zip</small></button>
      </div>
      <div class="field-group">
        <span class="box-label">Chords</span>
        <div class="ab-row">
          <button class="button secondary" data-action="export-chords" data-format="txt">Chord chart (.txt)</button>
          <button class="button secondary" data-action="export-chords" data-format="lab">.lab file</button>
        </div>
      </div>
      <div class="field-row">
        <label for="export-format" class="box-label">Format</label>
        <select id="export-format" class="export-format" data-action="export-format" aria-label="Export format">
          <option value="flac" ${format === "flac" ? "selected" : ""}>FLAC · smaller, lossless</option>
          <option value="wav" ${format === "wav" ? "selected" : ""}>WAV · most compatible</option>
        </select>
      </div>`,
  );
}

/** Updates every panel and chip for `project`, in place. */
export function updatePanels(project: Project): void {
  const speed = projectSpeed(project);
  const semitones = projectSemitones(project);
  const record = cachedAnalysis(project.id);
  const grid = projectGrid(project.id);
  const key = songKey(record);

  // Speed.
  const slider = document.querySelector<HTMLInputElement>("#speed");
  if (slider) {
    const value = String(Math.round(speed * 100));
    if (slider.value !== value && document.activeElement !== slider) slider.value = value;
    slider.setAttribute("aria-valuetext", formatSpeed(speed));
  }
  setText("#speed-value", formatSpeed(speed));
  setText("#speed-chip-value", formatSpeed(speed));
  setText("#speed-bpm", grid ? `${Math.round(grid.bpm * speed)} BPM · original ${Math.round(grid.bpm)}` : "");
  setDisabled('[data-action="speed-step"][data-step="-1"]', speed <= MIN_SPEED);
  setDisabled('[data-action="speed-step"][data-step="1"]', speed >= MAX_SPEED);
  for (const preset of document.querySelectorAll<HTMLElement>('[data-action="speed-preset"]')) {
    const on = Math.abs(Number(preset.dataset.speed) - speed) < 0.001;
    preset.classList.toggle("on", on);
    preset.setAttribute("aria-pressed", String(on));
  }

  // Key.
  setText("#key-value", formatSemitones(semitones));
  setText("#key-chip-value", key ? keyName(transposeKey(key, semitones)) : formatSemitones(semitones));
  setText("#key-unit", semitones === 0 ? (key ? keyName(key) : "As recorded") : `${Math.abs(semitones)} semitone${
    Math.abs(semitones) === 1 ? "" : "s"
  } ${semitones > 0 ? "up" : "down"}${key ? ` · ${keyName(transposeKey(key, semitones))}` : ""}`);
  setDisabled('[data-action="key-step"][data-step="-1"]', semitones <= MIN_SEMITONES);
  setDisabled('[data-action="key-step"][data-step="1"]', semitones >= MAX_SEMITONES);
  for (const step of [-1, 1]) {
    const button = document.querySelector<HTMLButtonElement>(`[data-action="key-step"][data-step="${step}"]`);
    if (!button) continue;
    const target = Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, semitones + step));
    const label = `Key ${step < 0 ? "down" : "up"} a semitone`;
    button.setAttribute("aria-label", key ? `${label} (to ${keyName(transposeKey(key, target))})` : label);
  }
  const keyGrid = document.querySelector<HTMLElement>("#key-grid");
  if (keyGrid) {
    const html = keyGridMarkup(key, semitones);
    if (keyGrid.innerHTML !== html) keyGrid.innerHTML = html;
  }
  const names = document.querySelector<HTMLInputElement>("#chord-names");
  if (names) names.checked = project.chordNames !== "original";
  if (record) updateSongKey(record);
  setText("#song-key-chip", record === undefined || analysisStatus(project.id).running
    ? "Key…"
    : key
    ? semitones ? `${keyName(key)} → ${keyName(transposeKey(key, semitones))}` : keyName(key)
    : record?.key === null
    ? "No key"
    : record
    ? "Key unclear"
    : "Key —");

  // Loop.
  const loop = project.loop;
  setText("#loop-value", loop ? `${formatPrecise(loop.start)}–${formatPrecise(loop.end)}` : "Off");
  const bars = grid && loop ? loopBars(grid, loop) : null;
  const loopText = !loop ? "Off" : bars ? `${bars} bar${bars === 1 ? "" : "s"}` : `${formatTime(loop.start)}–${formatTime(loop.end)}`;
  setText("#loop-chip-value", loop && !loop.enabled ? `${loopText} · off` : loopText);
  for (const toggle of document.querySelectorAll<HTMLElement>('[data-action="loop-toggle"]')) {
    toggle.classList.toggle("on", loop?.enabled ?? false);
    toggle.setAttribute("aria-pressed", String(loop?.enabled ?? false));
    toggle.title = loop ? "Turn the loop on or off (L)" : "Loop 4 bars from the playhead (L)";
  }
  document.querySelector('[data-panel="loop"]')?.classList.toggle("on", loop?.enabled ?? false);
  setDisabled('[data-action="loop-clear"]', !loop);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="loop-bars"]')) {
    button.disabled = !grid;
  }

  // Rhythm.
  updateRhythm(project, record, speed);

  // Export.
  const practice = document.querySelector<HTMLElement>(".export-practice");
  if (practice) practice.hidden = isNeutral(project);
}

function keyGridMarkup(key: ReturnType<typeof songKey>, semitones: number): string {
  const shifts = Array.from({ length: 12 }, (_, i) => i - 5);
  return shifts.map((shift) => {
    const on = shift === semitones;
    const name = key ? keyName(transposeKey(key, shift)).replace(" major", "").replace(" minor", "m") : formatSemitones(shift);
    return `<button class="preset key-option${on ? " on" : ""}" data-action="key-set" data-semitones="${shift}" aria-pressed="${on}" aria-label="${
      escapeHtml(`${key ? `${keyName(transposeKey(key, shift))}, ` : ""}${formatSemitones(shift)}`)
    }"><strong>${escapeHtml(name)}</strong>${key ? `<small>${shift === 0 ? "0" : formatSemitones(shift)}</small>` : ""}</button>`;
  }).join("");
}

function updateSongKey(record: AnalysisRecord): void {
  const detected = record.key;
  const parts: string[] = [];
  if (record.keyOverride) {
    parts.push(`You set it${detected ? `; detected ${keyName(detected)}` : ""}.`);
  } else if (!detected) {
    parts.push("No key: the stems without drums are silent.");
  } else if (detected.confidence < KEY_UNCLEAR) {
    parts.push(`Unclear: perhaps ${keyName(detected)} or ${keyName(detected.alternative)}.`);
  } else {
    parts.push(`Detected, ${Math.round(detected.confidence * 100)}% sure.`);
  }
  if (record.modulations && record.modulations.length > 1) {
    parts.push(`Changes key: ${
      record.modulations.slice(1).map((change) => `${keyName(change)} at ${formatTime(change.start)}`).join(", ")
    }.`);
  }
  if (record.tuningCents && Math.abs(record.tuningCents) >= 5) {
    const cents = Math.round(record.tuningCents);
    parts.push(`Tuned ${cents > 0 ? "+" : "−"}${Math.abs(cents)} cents.`);
  }
  setText("#key-status", parts.join(" "));
  const alternative = document.querySelector<HTMLButtonElement>("#key-alternative");
  if (alternative) {
    const other = detected ? (sameKey(record.keyOverride, detected.alternative) ? detected : detected.alternative) : null;
    alternative.hidden = !other;
    if (other) {
      alternative.textContent = `Use ${keyName(other)}`;
      alternative.dataset.key = `${other.tonic}:${other.mode}`;
    }
  }
  const select = document.querySelector<HTMLSelectElement>("#key-select");
  if (select && document.activeElement !== select) {
    const value = record.keyOverride ? `${record.keyOverride.tonic}:${record.keyOverride.mode}` : "";
    if (select.value !== value) select.value = value;
    select.options[0].textContent = detected ? `Detected (${keyName(detected)})` : "Detected";
  }
}

function updateRhythm(project: Project, record: AnalysisRecord | null | undefined, speed: number): void {
  const grid = projectGrid(project.id);
  const status = analysisStatus(project.id);
  const edits = record?.edits ?? {};
  const factor = edits.bpmFactor ?? 1;
  const tempo = grid ? `${formatTempo(grid.bpm, speed)}${grid.confidence < LOW_CONFIDENCE ? "?" : ""}` : "";
  setText("#tempo-bpm", grid ? formatTempo(grid.bpm, speed) : "—");
  setText("#tempo-chip", status.running ? `Analyzing… ${status.progress}%` : grid ? `${tempo} BPM` : record === undefined ? "…" : "No beat");
  setText("#metre-chip", grid ? `${grid.beatsPerBar}/4` : "—");
  setText("#click-note", grid ? `Follows the beat grid · ${Math.round(grid.bpm * speed)} BPM` : "Needs a beat grid: tap the tempo");
  let note = "";
  if (status.running) note = `Analyzing… ${status.progress}%`;
  else if (status.error) note = status.error;
  else if (!record) note = "";
  else if (!grid) note = "No steady beat found. Tap the tempo while it plays.";
  else if (edits.tapped) note = `Tapped at ${edits.tapped.bpm} BPM`;
  else {
    note = `Detected in the ${record.source === "drums" ? "drums" : "full mix"}${
      record.alternativeBpm ? `; maybe ${Math.round(record.alternativeBpm)}` : ""
    }`;
  }
  if (grid && grid.confidence < LOW_CONFIDENCE) note = `Low confidence: check the grid. ${note}`;
  setText("#tempo-status", note);
  setDisabled('[data-action="tempo-factor"][data-factor="0.5"]', !grid || factor <= MIN_BPM_FACTOR);
  setDisabled('[data-action="tempo-factor"][data-factor="2"]', !grid || factor >= MAX_BPM_FACTOR);
  setDisabled('[data-action="tempo-tap"]', !record);
  setHidden('[data-action="tempo-reset"]', Object.keys(edits).length === 0);
  setDisabled('[data-action="analyze"]', status.running);
  setText("#metre-detected", record ? `Detected: ${record.beatsPerBar}/4` : "");
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="tempo-metre"]')) {
    const pressed = grid?.beatsPerBar === Number(button.dataset.beats);
    button.setAttribute("aria-pressed", String(pressed));
    button.classList.toggle("on", pressed);
    button.disabled = !grid;
  }
  setDisabled('[data-action="tempo-downbeat"][data-step="-1"]', !grid);
  setDisabled('[data-action="tempo-downbeat"][data-step="1"]', !grid);
  const shift = edits.downbeatShift ?? 0;
  setText("#downbeat-label", !grid ? "" : shift === 0 ? "As detected" : `${Math.abs(shift)} beat${
    Math.abs(shift) === 1 ? "" : "s"
  } ${shift > 0 ? "later" : "earlier"} than detected`);
  for (const toggle of document.querySelectorAll<HTMLInputElement>('[data-action="click-toggle"]')) {
    if (toggle instanceof HTMLInputElement) toggle.checked = project.clickOn === true;
    toggle.disabled = !grid;
  }
}

function setText(selector: string, text: string): void {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.textContent !== text) element.textContent = text;
  }
}

function setDisabled(selector: string, disabled: boolean): void {
  for (const element of document.querySelectorAll<HTMLButtonElement>(selector)) element.disabled = disabled;
}

function setHidden(selector: string, hidden: boolean): void {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) element.hidden = hidden;
}
