import { chordIndexAt, type ChordNaming, nameChord } from "../analysis/chord-sheet";
import { beatIndexAt } from "../analysis/grid";
import { KEY_UNCLEAR } from "../analysis/key";
import { ALL_KEYS, keyName, sameKey, transposeKey } from "../analysis/spelling";
import { playerTime } from "../player";
import { state } from "../state";
import { formatSemitones, MAX_SEMITONES, MIN_SEMITONES, projectSemitones } from "../practice";
import { analysisStatus, cachedAnalysis, projectGrid } from "../tasks/analysis";
import type { AnalysisRecord, ChordSegment, MusicalKey, Project } from "../types";
import { escapeHtml, formatTime } from "./format";
import { timelineView } from "./timeline";

/**
 * Key and chords: the key chip in the practice bar and its panel, the
 * now/next chord display, and the chord lane under the bar ruler. Updated in
 * place as the analysis arrives and the track plays.
 */

let panelOpen = false;
const ANNOUNCE_KEY = "osplit-web-announce-chords";

export function keyPanelOpen(): boolean {
  return panelOpen;
}

export function setKeyPanelOpen(open: boolean): void {
  panelOpen = open;
}

/** Whether chord changes are announced to screen readers (a per-browser setting). */
export function announceChords(): boolean {
  try {
    return localStorage.getItem(ANNOUNCE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAnnounceChords(on: boolean): void {
  try {
    if (on) localStorage.setItem(ANNOUNCE_KEY, "1");
    else localStorage.removeItem(ANNOUNCE_KEY);
  } catch {
    // Not saved; the setting lasts until the page reloads.
  }
  const now = document.querySelector<HTMLElement>("#chord-now");
  now?.setAttribute("aria-live", on ? "polite" : "off");
}

/** The key the song is in as far as the app knows: the user's, else a clear detected one. */
export function songKey(record: AnalysisRecord | null | undefined): MusicalKey | null {
  if (!record) return null;
  if (record.keyOverride) return record.keyOverride;
  return record.key && record.key.confidence >= KEY_UNCLEAR ? record.key : null;
}

/** How the project's chords are named: as heard (with the key shift) unless set to original. */
export function chordNaming(project: Project): ChordNaming {
  const record = cachedAnalysis(project.id);
  const semitones = project.chordNames === "original" ? 0 : projectSemitones(project);
  // Spelled for the key even when it is unclear: the best guess beats none.
  const key = record?.keyOverride ?? record?.key ?? null;
  return { key: key ? transposeKey(key, semitones) : null, semitones };
}

/** "A minor", or "A minor → B minor (+2)" with a key shift. */
export function keyText(key: MusicalKey, semitones: number): string {
  if (semitones === 0) return keyName(key);
  return `${keyName(key)} → ${keyName(transposeKey(key, semitones))} (${formatSemitones(semitones)})`;
}

export function keyChipMarkup(): string {
  return `
      <div class="practice-group song-key-group" role="group" aria-label="Song key">
        <button class="tempo-chip key-chip" id="key-chip" data-action="key-panel" aria-controls="key-panel" aria-expanded="false" hidden>…</button>
      </div>
  `;
}

export function keyPanelMarkup(): string {
  return `
    <div class="tempo-panel key-panel" id="key-panel" ${panelOpen ? "" : "hidden"}>
      <p class="tempo-status" id="key-status" aria-live="polite"></p>
      <div class="tempo-actions">
        <button class="button text-button" data-action="key-alternative" id="key-alternative" hidden></button>
        <label class="practice-group"><span class="practice-label">Set key</span>
          <select id="key-select" data-action="key-select" aria-label="Set the key">
            <option value="">Detected</option>
            ${
    ALL_KEYS.map((key) => `<option value="${key.tonic}:${key.mode}">${keyName(key)}</option>`).join("")
  }
          </select>
        </label>
        <div class="practice-group" role="group" aria-label="Show chords as">
          <span class="practice-label">Show as</span>
          <button class="step-button" data-action="chord-names" data-names="original" aria-pressed="false">Original</button>
          <button class="step-button" data-action="chord-names" data-names="transposed" aria-pressed="false">Transposed</button>
        </div>
        <label class="check-row"><input type="checkbox" data-action="announce-chords" ${
    announceChords() ? "checked" : ""
  } /> Announce chord changes</label>
        <button class="button text-button" data-action="export-chords" data-format="txt">Export chords (.txt)</button>
        <button class="button text-button" data-action="export-chords" data-format="lab">Export .lab</button>
      </div>
    </div>
  `;
}

/** The large current chord and the next one, above the stems. */
export function chordNowMarkup(): string {
  return `
    <div class="chord-now" id="chord-now" aria-live="${announceChords() ? "polite" : "off"}" hidden>
      <span class="practice-label">Chord</span>
      <strong class="chord-current" id="chord-current"></strong>
      <span class="chord-next" id="chord-next"></span>
    </div>
  `;
}

/** A strip of chord boxes aligned with the waveforms; click to seek, double-click to loop. */
export function chordLaneMarkup(): string {
  return `<div class="chord-lane" id="chord-lane" role="group" aria-label="Chords (click to seek, double-click to loop)" hidden><div class="chord-track"></div><span class="playhead"></span></div>`;
}

/** What the lane shows now, so it is rebuilt only when that changes. */
let laneKey = "";

/** Updates the key chip, its panel, the chord lane and display for `project`, in place. */
export function updateHarmonyDisplay(project: Project): void {
  const chip = document.querySelector<HTMLButtonElement>("#key-chip");
  if (!chip) return;
  const record = cachedAnalysis(project.id);
  const status = analysisStatus(project.id);
  const semitones = projectSemitones(project);
  const analysed = Boolean(record && record.chords);
  const key = songKey(record);
  let text: string;
  if (!analysed) text = status.running ? "Key…" : "";
  else if (key) text = keyText(key, semitones);
  else text = record!.key === null ? "No key" : "Key unclear";
  chip.hidden = text === "";
  if (chip.textContent !== text) chip.textContent = text;
  chip.disabled = !analysed;
  chip.setAttribute("aria-expanded", String(panelOpen && analysed));
  chip.title = analysed ? "Key and chords" : "";

  // The key buttons say where they lead.
  for (const step of [-1, 1]) {
    const button = document.querySelector<HTMLButtonElement>(`[data-action="key-step"][data-step="${step}"]`);
    if (!button) continue;
    const target = Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, semitones + step));
    const label = `Key ${step < 0 ? "down" : "up"} a semitone`;
    button.setAttribute("aria-label", key ? `${label} (to ${keyName(transposeKey(key, target))})` : label);
    button.title = key ? `${keyName(transposeKey(key, target))} (${formatSemitones(target)})` : "";
  }

  const panel = document.querySelector<HTMLElement>("#key-panel");
  if (panel) {
    panel.hidden = !panelOpen || !analysed;
    if (analysed) updatePanel(project, record!);
  }
  updateLane(project, record);
  updateChordNow(project);
}

function updatePanel(project: Project, record: AnalysisRecord): void {
  const status = document.querySelector<HTMLElement>("#key-status");
  if (status) status.innerHTML = statusMarkup(record);
  const alternative = document.querySelector<HTMLButtonElement>("#key-alternative");
  const detected = record.key;
  if (alternative) {
    const other = detected
      ? (sameKey(record.keyOverride, detected.alternative) ? detected : detected.alternative)
      : null;
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
  const names = project.chordNames === "original" ? "original" : "transposed";
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="chord-names"]')) {
    const pressed = button.dataset.names === names;
    button.setAttribute("aria-pressed", String(pressed));
    button.classList.toggle("on", pressed);
  }
  const hasChords = (record.chords ?? []).some((chord) => chord.root !== null);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="export-chords"]')) {
    button.disabled = !hasChords;
  }
}

function statusMarkup(record: AnalysisRecord): string {
  const parts: string[] = [];
  const detected = record.key;
  if (record.keyOverride) {
    parts.push(`You set the key to ${keyName(record.keyOverride)}.`);
    if (detected) parts.push(`Detected: ${keyName(detected)}.`);
  } else if (!detected) {
    parts.push("No key: the stems without drums are silent.");
  } else if (detected.confidence < KEY_UNCLEAR) {
    parts.push(`Key unclear (best guess ${keyName(detected)}, or ${keyName(detected.alternative)}).`);
  } else {
    parts.push(
      `Detected ${keyName(detected)} (${Math.round(detected.confidence * 100)}% confident). It may also be ${
        keyName(detected.alternative)
      }.`,
    );
  }
  if (record.modulations && record.modulations.length > 1) {
    const changes = record.modulations.slice(1).map((change) => `${keyName(change)} at ${formatTime(change.start)}`);
    parts.push(`Changes key: ${changes.join(", ")}.`);
  }
  if (record.tuningCents && Math.abs(record.tuningCents) >= 5) {
    const cents = Math.round(record.tuningCents);
    parts.push(`Tuned ${cents > 0 ? "+" : "−"}${Math.abs(cents)} cents from A = 440 Hz.`);
  }
  parts.push("Chords are simplified to major and minor.");
  return escapeHtml(parts.join(" "));
}

function trackDuration(record: AnalysisRecord | null | undefined): number {
  return playerTime().duration || record?.duration || 0;
}

function updateLane(project: Project, record: AnalysisRecord | null | undefined): void {
  const lane = document.querySelector<HTMLElement>("#chord-lane");
  const track = lane?.querySelector<HTMLElement>(".chord-track");
  if (!lane || !track) return;
  const chords = record?.chords ?? [];
  const duration = trackDuration(record);
  const naming = chordNaming(project);
  const show = chords.some((chord) => chord.root !== null) && duration > 0;
  // The boxes span the whole track inside `track`, which the view shifts
  // and stretches; they are rebuilt only when their text or width changes.
  const width = show ? lane.clientWidth * (duration / (timelineView(duration).span || duration)) : 0;
  const key = show
    ? `${project.id}|${duration}|${naming.semitones}|${naming.key?.tonic}:${naming.key?.mode}|${Math.round(width)}|${
      chords.length
    }|${chords[0]?.start}|${chords.at(-1)?.end}`
    : "";
  lane.hidden = !show;
  positionChordLane(duration);
  if (key === laneKey && track.querySelector(".chord-box")) return;
  laneKey = key;
  track.replaceChildren();
  if (!show) return;
  const html = chords.map((chord, index) => {
    if (chord.root === null) return "";
    const left = (chord.start / duration) * 100;
    const size = ((Math.min(chord.end, duration) - chord.start) / duration) * 100;
    const name = escapeHtml(nameChord(chord, naming));
    const narrow = width > 0 && (size / 100) * width < name.length * 7 + 6;
    return `<button class="chord-box${narrow ? " narrow" : ""}" data-action="chord-seek" data-index="${index}" style="left:${
      left.toFixed(3)
    }%;width:${size.toFixed(3)}%" aria-label="${name} at ${formatTime(chord.start)}" title="${name} · ${
      formatTime(chord.start)
    }"><span>${name}</span></button>`;
  }).join("");
  track.insertAdjacentHTML("beforeend", html);
  lastCurrent = -2;
}

/** Shifts and stretches the chord boxes to the current view. */
export function positionChordLane(duration = playerTime().duration): void {
  const track = document.querySelector<HTMLElement>("#chord-lane .chord-track");
  if (!track || !(duration > 0)) return;
  const view = timelineView(duration);
  track.style.left = `${(-view.start / view.span) * 100}%`;
  track.style.width = `${(duration / view.span) * 100}%`;
}

/** Index of the chord last highlighted, so the display changes only when it does. */
let lastCurrent = -2;

/** Shows the chord at the playhead and the next one (called on ticks and while playing). */
export function updateChordNow(project: Project): void {
  const now = document.querySelector<HTMLElement>("#chord-now");
  if (!now) return;
  const record = cachedAnalysis(project.id);
  const chords = record?.chords ?? [];
  const show = chords.some((chord) => chord.root !== null);
  now.hidden = !show;
  if (!show) return;
  const { position } = playerTime();
  const naming = chordNaming(project);
  const index = chordIndexAt(chords, position);
  const current = index >= 0 ? chords[index] : null;
  const next = nextChord(chords, index);
  setText("#chord-current", current ? nameChord(current, naming) : "—");
  let nextText = "";
  if (next) {
    const grid = projectGrid(project.id);
    const name = nameChord(next, naming);
    if (grid) {
      const beats = Math.max(1, beatIndexAt(grid, next.start + 0.02) - beatIndexAt(grid, position));
      nextText = `→ ${name} in ${beats}`;
    } else {
      nextText = `→ ${name} in ${Math.max(0.1, next.start - position).toFixed(1)} s`;
    }
  }
  setText("#chord-next", nextText);
  if (index !== lastCurrent) {
    lastCurrent = index;
    for (const box of document.querySelectorAll<HTMLElement>(".chord-box")) {
      box.classList.toggle("current", Number(box.dataset.index) === index);
    }
  }
}

/** The next sounding chord after `index` (skipping "no chord"). */
function nextChord(chords: ChordSegment[], index: number): ChordSegment | null {
  for (let i = index + 1; i < chords.length; i++) {
    if (chords[i].root !== null) return chords[i];
  }
  return null;
}

/** The chord segment a lane box stands for. */
export function chordForBox(project: Project, box: HTMLElement): ChordSegment | null {
  const chords = cachedAnalysis(project.id)?.chords;
  return chords?.[Number(box.dataset.index)] ?? null;
}

let frame = 0;

/** Keeps the chord display smooth while playing (the player ticks only 4 times a second). */
export function followChords(): void {
  if (frame || !playerTime().playing) return;
  const step = () => {
    frame = 0;
    const project = state.selectedProject;
    if (!project || !playerTime().playing || !document.querySelector("#chord-now")) return;
    updateChordNow(project);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

/** Parses a key select value "tonic:mode". */
export function parseKey(value: string | undefined): MusicalKey | undefined {
  const [tonic, mode] = (value ?? "").split(":");
  if (mode !== "major" && mode !== "minor") return undefined;
  const pc = Number(tonic);
  return Number.isInteger(pc) && pc >= 0 && pc < 12 ? { tonic: pc, mode } : undefined;
}

function setText(selector: string, text: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element && element.textContent !== text) element.textContent = text;
}
