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
  type Track,
  TRACK_LABELS,
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

/** What the Export panel exports, and the stems picked (all by default). */
type ExportWhat = "stems" | "mix" | "chords";
let exportWhat: ExportWhat = "stems";
let exportPicked: Set<Track> | null = null;
let exportProjectId = "";

export function exportChoice(project: Project): { what: ExportWhat; tracks: Track[] } {
  return { what: exportWhat, tracks: pickedTracks(project) };
}

export function setExportWhat(what: string | undefined): void {
  if (what === "stems" || what === "mix" || what === "chords") exportWhat = what;
}

function exportTracks(project: Project): Track[] {
  const stems: Track[] = ALL_STEMS.filter((stem) => project.completedStems.includes(stem));
  return projectGrid(project.id) ? [...stems, "click"] : stems;
}

function pickedTracks(project: Project): Track[] {
  if (exportProjectId !== project.id || !exportPicked) {
    exportProjectId = project.id;
    exportPicked = new Set(ALL_STEMS.filter((stem) => project.completedStems.includes(stem)));
  }
  return exportTracks(project).filter((track) => exportPicked!.has(track));
}

/** Ticks or unticks a stem, or all of them (`track` null). */
export function toggleExportTrack(project: Project, track: Track | null): void {
  const picked = new Set(pickedTracks(project));
  if (track === null) {
    const all = exportTracks(project);
    exportPicked = picked.size === all.length ? new Set() : new Set(all);
  } else {
    if (picked.has(track)) picked.delete(track);
    else picked.add(track);
    exportPicked = picked;
  }
}

export function exportPanel(): string {
  return panel(
    "export",
    "Export",
    `
      <div class="segmented export-what" role="group" aria-label="What to export">
        <button data-action="export-what" data-what="stems" aria-pressed="false">Stems</button>
        <button data-action="export-what" data-what="mix" aria-pressed="false">Mix</button>
        <button data-action="export-what" data-what="chords" aria-pressed="false">Chords</button>
      </div>
      <div class="export-section" data-export="stems">
        <div class="field-row"><strong>Stems</strong><button class="text-action" data-action="export-pick-all"></button></div>
        <div class="stem-picks" id="stem-picks"></div>
        <small class="muted" id="stems-note"></small>
      </div>
      <div class="export-section" data-export="mix">
        <p class="panel-note">One audio file of what you hear now: the mixer levels, mutes and solos, and the click if it is on.</p>
        <label class="switch-row compact export-practice">
          <span><strong>Apply speed, key and loop</strong><small id="export-practice-note"></small></span>
          <input type="checkbox" role="switch" class="switch" data-action="export-practice" ${
      exportAppliesPractice() ? "checked" : ""
    } />
        </label>
      </div>
      <div class="export-section" data-export="chords">
        <p class="panel-note">A text chord chart with bar numbers and your markers as section headings, named as the chart shows them.</p>
        <pre class="chord-preview" id="chord-preview"></pre>
        <button class="text-action" data-action="export-chords" data-format="lab">Also as a .lab file (for DAWs)</button>
      </div>
      <div class="field-row export-format-row" data-export-audio>
        <span class="box-label">Format</span>
        <div class="segmented" role="group" aria-label="Format">
          <button data-action="export-format" data-format="flac" aria-pressed="false">FLAC</button>
          <button data-action="export-format" data-format="wav" aria-pressed="false">WAV</button>
        </div>
      </div>
      <button class="button primary export-run" data-action="export-run"></button>
      <small class="muted export-size" id="export-size"></small>`,
  );
}

/** Updates the Export panel in place. */
function updateExport(project: Project): void {
  const root = document.querySelector<HTMLElement>("#panel-export");
  if (!root) return;
  for (const button of root.querySelectorAll<HTMLElement>('[data-action="export-what"]')) {
    const on = button.dataset.what === exportWhat;
    button.setAttribute("aria-pressed", String(on));
  }
  for (const section of root.querySelectorAll<HTMLElement>("[data-export]")) {
    section.hidden = section.dataset.export !== exportWhat;
  }
  const audio = root.querySelector<HTMLElement>("[data-export-audio]");
  if (audio) audio.hidden = exportWhat === "chords";
  const format = exportFormat();
  for (const button of root.querySelectorAll<HTMLElement>('[data-action="export-format"]')) {
    button.setAttribute("aria-pressed", String(button.dataset.format === format));
  }
  const all = exportTracks(project);
  const picked = pickedTracks(project);
  const picks = root.querySelector<HTMLElement>("#stem-picks");
  if (picks) {
    const html = all.map((track) => {
      const on = picked.includes(track);
      return `<button class="stem-pick stem-${track}" role="checkbox" aria-checked="${on}" data-action="export-pick" data-stem="${track}"><span class="pick-box" aria-hidden="true"></span><span class="stem-dot" aria-hidden="true"></span>${TRACK_LABELS[track]}</button>`;
    }).join("");
    if (picks.innerHTML !== html) picks.innerHTML = html;
  }
  setText('[data-action="export-pick-all"]', picked.length === all.length ? "Clear all" : "Select all");
  setText("#stems-note", picked.length > 1 ? "Several stems download as one zip file." : "One stem downloads as a single audio file.");
  const speed = formatSpeed(projectSpeed(project));
  const semitones = projectSemitones(project);
  const practice = document.querySelector<HTMLInputElement>('[data-action="export-practice"]');
  const neutral = isNeutral(project);
  setText("#export-practice-note", neutral
    ? "Nothing to apply: the speed and key are as recorded and there is no loop"
    : exportAppliesPractice()
    ? `${speed}, key ${formatSemitones(semitones)}${project.loop?.enabled ? ", only the looped part" : ""}`
    : "Off: the whole song at the original speed and key");
  if (practice) practice.disabled = neutral;
  const label = exportWhat === "chords"
    ? "Export chords · .txt"
    : exportWhat === "mix"
    ? `Export mix · ${format.toUpperCase()}`
    : picked.length === 0
    ? "Choose at least one stem"
    : picked.length === 1
    ? `Export 1 stem · ${format.toUpperCase()}`
    : `Export ${picked.length} stems · zip`;
  const run = root.querySelector<HTMLButtonElement>('[data-action="export-run"]');
  if (run) {
    run.textContent = label;
    run.disabled = exportWhat === "stems" ? picked.length === 0 : exportWhat === "chords" ? !hasChords(project) : false;
  }
  const duration = cachedAnalysis(project.id)?.duration ?? 0;
  // FLAC is about half the size of 16-bit WAV.
  const perFile = (duration * 44_100 * 4 * (format === "flac" ? 0.55 : 1)) / 1_000_000;
  setText("#export-size", exportWhat === "chords"
    ? "Uses the chord names shown in the chart"
    : duration
    ? `About ${Math.max(1, Math.round(perFile * (exportWhat === "mix" ? 1 : Math.max(1, picked.length))))} MB`
    : "");
}

function hasChords(project: Project): boolean {
  return (cachedAnalysis(project.id)?.chords ?? []).some((chord) => chord.root !== null);
}

/** The chord preview: the first lines of the .txt chart. */
export function setChordPreview(text: string): void {
  setText("#chord-preview", text);
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

  updateExport(project);
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
