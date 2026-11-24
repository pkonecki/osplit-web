import { chordSheetText, exportChords, exportMix, exportStems, setExportAppliesPractice, setExportFormat } from "./export";
import { stepBar } from "./analysis/chart";
import { barLoop, MAX_BPM_FACTOR, MIN_BPM_FACTOR, tapTempo } from "./analysis/grid";
import { keyName } from "./analysis/spelling";
import { applyMixPreset, MIX_PRESETS } from "./mix-presets";
import { soloStems, toggleStem } from "./mixing";
import {
  applyPractice,
  applyStemVolume,
  isPlaying,
  pauseAll,
  playAll,
  playerTime,
  seekAll,
  setClickGrid,
} from "./player";
import { updateMediaSession } from "./player/media-session";
import {
  clampSemitones,
  clampSpeed,
  loopWithEnd,
  loopWithStart,
  normalizeLoop,
  projectSemitones,
  projectSpeed,
  SPEED_STEP,
} from "./practice";
import { state } from "./state";
import { saveProject } from "./storage";
import { analyzeProject, cachedAnalysis, projectGrid, saveGridEdits, saveKeyOverride } from "./tasks/analysis";
import { type ClickSubdivision, type GridEdits, METRES, type Project, type ProjectMarker, type Track } from "./types";
import { clampCapo } from "./capo";
import {
  addMarker,
  MAX_MARKER_NAME,
  removeMarker,
  renameMarker,
  sectionLoop,
  snapMarkers,
  stepMarker,
} from "./markers";
import { choiceDialog, textDialog } from "./view/dialog";
import {
  pendingMarkerBar,
  prepareMarkerPanel,
  stepPendingBar,
  updateCurrentMarker,
  updateMarkersView,
  updateScrubMarkers,
} from "./view/markers-view";
import {
  barForCell,
  currentBar,
  sectionLooped,
  segmentForCell,
  shownBars,
  updateChart,
  updateChartPlayhead,
} from "./view/chart";
import { chordNaming, keyText, parseKey, songKey, updateChordNow } from "./view/harmony";
import { stemRowsMarkup, updateMixer } from "./view/mixer";
import {
  exportChoice,
  isPanelName,
  openPanel,
  setChordPreview,
  setExportWhat,
  setPanel,
  toggleExportTrack,
  updatePanels,
} from "./view/panels";
import { updatePlayerDisplay, updateScrubLoop } from "./view/player-bar";
import { setPracticeTab, toggleMixerPanel } from "./view/practice-view";
import { loadSongPeaks } from "./view/song-peaks";

/**
 * What the practice view does: speed, key, loop, tempo corrections, the
 * click, the mixer and the chord chart. Changes update the page in place
 * (a slider being dragged or an open panel keeps working) and are saved
 * with the project.
 */

function project(): Project | null {
  return state.selectedProject?.completedStems.length ? state.selectedProject : null;
}

/** Updates everything the practice view shows for `current`, in place. */
export function updatePracticeDisplay(current: Project): void {
  updatePanels(current);
  updateMixer(current);
  updateScrubLoop(current);
  updateChart(current);
  updateMarkersView(current);
  updateScrubMarkers(current);
  updateChordNow(current);
  updatePlayerDisplay(current);
  updateMeta(current);
}

/** The phone header's line: key · tempo · metre. */
function updateMeta(current: Project): void {
  const meta = document.querySelector<HTMLElement>("#practice-meta");
  if (!meta) return;
  const parts = ["#song-key-chip", "#tempo-chip", "#metre-chip"]
    .map((selector) => document.querySelector(selector)?.textContent ?? "")
    .filter((part) => part && part !== "—");
  if (current.capo) parts.push(`Capo ${current.capo}`);
  const text = parts.join(" · ");
  if (meta.textContent !== text) meta.textContent = text;
}

/** After the project page renders: the chart's peaks, the analysis, the display. */
export function onPracticeRendered(current: Project): void {
  updatePracticeDisplay(current);
  void loadSongPeaks(current).then(() => {
    if (state.selectedProject?.id === current.id) updateChart(state.selectedProject);
  }).catch(console.warn);
}

/** Called on every player tick (4 times a second) and when it loads. */
export function practiceTick(): void {
  const current = project();
  updatePlayerDisplay(current);
  updateMediaSession(playerTime());
  if (!current) return;
  updateChordNow(current);
  updateChartPlayhead(current.id);
  updateCurrentMarker(current);
  followPlayback();
}

let frame = 0;
/** Keeps the chart and player smooth while playing. */
function followPlayback(): void {
  if (frame || !playerTime().playing) return;
  const step = () => {
    frame = 0;
    const current = project();
    if (!current || !playerTime().playing) return;
    updateChartPlayhead(current.id);
    updatePlayerDisplay(current);
    updateChordNow(current);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

/**
 * Applies the project's analysis to the page and the player: the click's
 * grid, the chart, the chips. Re-renders when the click row has to appear
 * or go.
 */
export function refreshAnalysis(current: Project): void {
  const grid = projectGrid(current.id);
  setClickGrid(current.id, grid);
  // The click row comes and goes with the grid, in place.
  const rows = document.querySelector<HTMLElement>("#mixer .stem-rows");
  const hasRow = document.querySelector('[data-stem-row="click"]') !== null;
  if (rows && hasRow !== (grid !== null)) rows.innerHTML = stemRowsMarkup(current);
  updatePracticeDisplay(current);
  // Markers follow the music when the grid changes (bar 1 moved, tempo ×2).
  const markers = current.markers;
  if (markers?.length && shownBars().length) {
    const snapped = snapMarkers(markers, shownBars());
    if (snapped !== markers) void saveMarkers(current, [...snapped]).catch(console.warn);
  }
}

/** Plays (`play` true) or pauses the project player. */
export async function togglePlay(play: boolean): Promise<void> {
  if (!play) await pauseAll();
  else if (state.selectedProject) await playAll(state.selectedProject);
  updatePlayerDisplay(project());
  updateMediaSession(playerTime());
  followPlayback();
}

export function seekTo(seconds: number): void {
  const { duration } = playerTime();
  seekAll(Math.max(0, Math.min(duration, seconds)));
  updateMediaSession(playerTime(), true);
  const current = project();
  if (current) {
    updatePlayerDisplay(current);
    updateChartPlayhead(current.id);
    updateChordNow(current);
  }
}

/**
 * Applies changed speed, key or loop to the player and the page, and saves
 * them unless `save` is false (a slider still being dragged).
 */
export async function savePractice(updated: Project, save = true): Promise<void> {
  // Set at once, so a quick next key press builds on this change.
  state.selectedProject = updated;
  updatePracticeDisplay(updated);
  const applied = applyPractice(updated);
  if (save) {
    const saved = await saveProject(updated);
    if (state.selectedProject === updated) state.selectedProject = saved;
  }
  await applied;
}

function stepSpeed(current: Project, steps: number): Promise<void> {
  return savePractice({ ...current, speed: clampSpeed(projectSpeed(current) + steps * SPEED_STEP) });
}

function stepKey(current: Project, steps: number): Promise<void> {
  return savePractice({ ...current, semitones: clampSemitones(projectSemitones(current) + steps) });
}

/** Sets the loop start (A) or end (B) at the playhead. */
function setLoopEdge(current: Project, edge: "start" | "end"): Promise<void> {
  const { position, duration } = playerTime();
  if (!duration) return Promise.resolve();
  const loop = edge === "start"
    ? loopWithStart(current.loop, position, duration)
    : loopWithEnd(current.loop, position, duration);
  return savePractice({ ...current, loop });
}

/** Seconds looped by the Loop button when there is no beat grid. */
const DEFAULT_LOOP_SECONDS = 4;

/**
 * The Loop button and L: turns the loop on or off, or makes one when there
 * is none (4 bars from the playhead, or 4 s without a beat grid).
 */
function toggleLoop(current: Project): Promise<void> {
  if (!current.loop) {
    const { position, duration } = playerTime();
    if (!duration) return Promise.resolve();
    const grid = projectGrid(current.id);
    const region = (grid ? barLoop(grid, position, 4, duration) : null) ??
      normalizeLoop(position, position + DEFAULT_LOOP_SECONDS, duration);
    if (!region) return Promise.resolve();
    return savePractice({ ...current, loop: { ...region, enabled: true } });
  }
  return savePractice({ ...current, loop: { ...current.loop, enabled: !current.loop.enabled } });
}

/** Loops `bars` bars from the bar containing the playhead. */
function loopBarsFromPlayhead(current: Project, bars: number): Promise<void> {
  const grid = projectGrid(current.id);
  const { position, duration } = playerTime();
  const region = grid && duration ? barLoop(grid, position, bars, duration) : null;
  if (!region) return Promise.resolve();
  return savePractice({ ...current, loop: { ...region, enabled: true } });
}

/** Shift-click on a bar: loops from the bar playing to that bar, whichever comes first. */
function loopToBar(current: Project, cell: HTMLElement): Promise<void> {
  const target = barForCell(cell);
  const playing = currentBar() ?? shownBars()[0];
  if (!target || !playing) return Promise.resolve();
  const start = Math.min(target.start, playing.start);
  const end = Math.max(target.end, playing.end);
  const region = normalizeLoop(start, end, playerTime().duration || end);
  if (!region) return Promise.resolve();
  return savePractice({ ...current, loop: { ...region, enabled: true } });
}

/** Previous or next bar (5 s without a beat grid). */
function stepBars(current: Project, direction: -1 | 1): void {
  const grid = projectGrid(current.id);
  const { position } = playerTime();
  seekTo(grid ? stepBar(grid, position, direction) : position + direction * 5);
}

/** Saves a correction to the project's beat grid. */
async function editGrid(current: Project, change: (edits: GridEdits) => GridEdits): Promise<void> {
  const record = cachedAnalysis(current.id);
  if (!record) return;
  const edits = change(record.edits ?? {});
  // Drop unset fields, so "no corrections" is an empty object.
  for (const key of Object.keys(edits) as (keyof GridEdits)[]) {
    if (edits[key] === undefined) delete edits[key];
  }
  await saveGridEdits(current.id, edits);
}

/** Tap times (seconds, page clock) of the current tap-tempo run. */
let taps: number[] = [];
/** A pause this long between taps starts a new run. */
const TAP_RESET_SECONDS = 2;

/**
 * Tap tempo: after four taps, replaces the grid with an even one at the
 * tapped tempo (allowing for the speed), with a beat at the last tap.
 */
async function tap(current: Project): Promise<void> {
  if (!cachedAnalysis(current.id)) return;
  const now = performance.now() / 1000;
  if (taps.length && now - taps[taps.length - 1] > TAP_RESET_SECONDS) taps = [];
  taps.push(now);
  const heard = tapTempo(taps);
  const button = document.querySelector<HTMLElement>('[data-action="tempo-tap"]');
  if (button) button.textContent = heard ? "Tap" : `Tap ${taps.length}…`;
  if (!heard) return;
  const bpm = Math.round((heard / projectSpeed(current)) * 10) / 10;
  await editGrid(current, (edits) => ({
    beatsPerBar: edits.beatsPerBar,
    metre: edits.metre,
    tapped: { bpm, anchor: playerTime().position },
  }));
}

/** Turns the click on or off: the mixer's Click M, the player button and Rhythm's switch. */
function toggleClick(current: Project, on = current.clickOn !== true): Promise<void> {
  if (!projectGrid(current.id)) return Promise.resolve();
  return saveMix({ ...current, clickOn: on });
}

function toggleMute(current: Project, track: Track): Promise<void> {
  if (track === "click") return toggleClick(current);
  return saveMix({ ...current, mutedStems: toggleStem(current.mutedStems, track) });
}

function toggleSolo(current: Project, track: Track): Promise<void> {
  return saveMix({ ...current, soloStems: toggleStem(soloStems(current), track) });
}

/** Applies a changed mix to every track, shows it and saves it. */
async function saveMix(updated: Project): Promise<void> {
  // Set at once, so a quick next press builds on this change.
  state.selectedProject = updated;
  for (const stem of updated.completedStems) applyStemVolume(updated, stem);
  applyStemVolume(updated, "click");
  updateMixer(updated);
  updatePanels(updated);
  const saved = await saveProject(updated);
  if (state.selectedProject === updated) state.selectedProject = saved;
}

/** Saves the project's markers and shows them. */
async function saveMarkers(current: Project, markers: ProjectMarker[]): Promise<void> {
  const updated: Project = { ...current, markers: markers.length ? markers : undefined };
  state.selectedProject = updated;
  updatePracticeDisplay(updated);
  const saved = await saveProject(updated);
  if (state.selectedProject === updated) state.selectedProject = saved;
}

function markerByBar(current: Project, bar: number): number {
  return (current.markers ?? []).findIndex((marker) => marker.bar === bar);
}

/** Loops a marker's section, or turns the loop off if it is that section already. */
function loopSection(current: Project, index: number): Promise<void> {
  const region = sectionLoop(current.markers ?? [], index, shownBars());
  if (!region) return Promise.resolve();
  if (sectionLooped(current, index, shownBars())) {
    return savePractice({ ...current, loop: { ...current.loop!, enabled: false } });
  }
  seekTo(region.start);
  return savePractice({ ...current, loop: { ...region, enabled: true } });
}

function jumpToMarker(current: Project, bar: number): void {
  const start = shownBars().find((item) => item.number === bar)?.start;
  const marker = (current.markers ?? []).find((item) => item.bar === bar);
  seekTo(start ?? marker?.time ?? 0);
}

/** Saves the marker the Add marker panel describes. */
async function saveNewMarker(current: Project): Promise<void> {
  const bar = shownBars().find((item) => item.number === pendingMarkerBar());
  if (!bar) return;
  const name = document.querySelector<HTMLInputElement>("#marker-name")?.value ?? "";
  setPanel(null);
  await saveMarkers(current, addMarker(current.markers ?? [], { bar: bar.number, time: bar.start, name }));
}

/** Rename or delete a marker: from its heading's context menu or a long press. */
async function markerMenu(bar: number): Promise<void> {
  const current = project();
  if (!current) return;
  const marker = (current.markers ?? []).find((item) => item.bar === bar);
  if (!marker) return;
  const choice = await choiceDialog(marker.name, [
    { value: "rename", label: "Rename" },
    { value: "delete", label: "Delete" },
  ]);
  const latest = project();
  if (!latest) return;
  if (choice === "rename") {
    const name = await textDialog("Rename marker", "Name", marker.name, MAX_MARKER_NAME);
    if (name) await saveMarkers(latest, renameMarker(latest.markers ?? [], bar, name));
  } else if (choice === "delete") {
    await saveMarkers(latest, removeMarker(latest.markers ?? [], bar));
  }
}

/** Shift+← / Shift+→: the previous or next marker. */
function stepMarkers(current: Project, direction: -1 | 1): void {
  const bar = currentBar();
  if (!bar) return;
  const atStart = playerTime().position - bar.start < 0.5;
  const marker = stepMarker(current.markers ?? [], bar.number, direction, atStart);
  if (marker) jumpToMarker(current, marker.bar);
}

/** How the chord chart names the key: as heard, or unclear. */
function keyLineFor(current: Project): string {
  const naming = chordNaming(current);
  const key = songKey(cachedAnalysis(current.id));
  return key
    ? keyText(key, naming.semitones)
    : naming.key
    ? `unclear (perhaps ${keyName(naming.key)})`
    : "unknown";
}

/** Downloads the chord chart (txt) or .lab file, named as the page shows them. */
function exportProjectChords(current: Project, format: string | undefined): void {
  exportChords(current, format === "lab" ? "lab" : "txt", chordNaming(current), keyLineFor(current));
}

/** The first lines of the chord chart, in the Export panel. */
function updateChordPreview(current: Project): void {
  const lines = chordSheetText(current, chordNaming(current), keyLineFor(current)).split("\n");
  setChordPreview(lines.slice(0, 14).join("\n") + (lines.length > 15 ? "\n…" : ""));
}

/** Handles a click on a practice control; false if the action isn't one. */
export async function handlePracticeClick(
  action: string,
  button: HTMLElement,
  event: Event,
): Promise<boolean> {
  // Panels and tabs work while the stems load.
  switch (action) {
    case "panel": {
      const name = button.dataset.panel;
      if (!isPanelName(name)) return true;
      const opening = openPanel() !== name;
      if (opening && name === "marker") prepareMarkerPanel();
      setPanel(opening ? name : null);
      if (opening && name === "marker") document.querySelector<HTMLElement>("#marker-name")?.focus();
      if (opening && name === "export" && project()) updateChordPreview(project()!);
      return true;
    }
    case "panel-close":
      setPanel(null);
      return true;
    case "practice-tab":
      setPracticeTab(button.dataset.tab === "mixer" ? "mixer" : "chords");
      return true;
    case "mixer-toggle":
      toggleMixerPanel();
      return true;
  }
  const current = project();
  if (!current) return false;
  switch (action) {
    case "play":
      await togglePlay(!isPlaying());
      return true;
    case "bar-step":
      stepBars(current, Number(button.dataset.step) < 0 ? -1 : 1);
      return true;
    case "bar-seek": {
      const bar = barForCell(button);
      if (!bar) return true;
      if ((event as MouseEvent).shiftKey) await loopToBar(current, button);
      else seekTo(bar.start);
      return true;
    }
    case "chord-seek": {
      const chord = segmentForCell(button);
      if (chord) seekTo(chord.start);
      return true;
    }
    case "marker-jump":
      jumpToMarker(current, Number(button.dataset.bar));
      return true;
    case "marker-loop": {
      const index = markerByBar(current, Number(button.dataset.bar));
      if (index >= 0) await loopSection(current, index);
      return true;
    }
    case "marker-bar":
      stepPendingBar(Number(button.dataset.step));
      return true;
    case "marker-preset": {
      const input = document.querySelector<HTMLInputElement>("#marker-name");
      if (input) {
        input.value = button.dataset.name ?? "";
        input.focus();
      }
      return true;
    }
    case "marker-save":
      await saveNewMarker(current);
      return true;
    case "speed-step":
      await stepSpeed(current, Number(button.dataset.step));
      return true;
    case "speed-preset":
      await savePractice({ ...current, speed: clampSpeed(Number(button.dataset.speed)) });
      return true;
    case "speed-reset":
      await savePractice({ ...current, speed: 1 });
      return true;
    case "key-step":
      await stepKey(current, Number(button.dataset.step));
      return true;
    case "key-set":
      await savePractice({ ...current, semitones: clampSemitones(Number(button.dataset.semitones)) });
      return true;
    case "key-reset":
      await savePractice({ ...current, semitones: 0 });
      return true;
    case "key-alternative":
      await saveKeyOverride(current.id, parseKey(button.dataset.key));
      return true;
    case "loop-set":
      await setLoopEdge(current, button.dataset.edge === "start" ? "start" : "end");
      return true;
    case "loop-toggle":
      await toggleLoop(current);
      return true;
    case "loop-clear":
      await savePractice({ ...current, loop: undefined });
      return true;
    case "loop-bars":
      await loopBarsFromPlayhead(current, Number(button.dataset.bars));
      return true;
    case "click-button":
      if (!projectGrid(current.id)) {
        setPanel("rhythm");
        return true;
      }
      await toggleClick(current);
      return true;
    case "mute":
      if (button.dataset.stem) await toggleMute(current, button.dataset.stem as Track);
      return true;
    case "solo":
      if (button.dataset.stem) await toggleSolo(current, button.dataset.stem as Track);
      return true;
    case "mix-preset": {
      const preset = MIX_PRESETS.find((item) => item.id === button.dataset.preset);
      if (preset) await saveMix(applyMixPreset(current, preset));
      return true;
    }
    case "export-what":
      setExportWhat(button.dataset.what);
      if (button.dataset.what === "chords") updateChordPreview(current);
      updatePanels(current);
      return true;
    case "export-pick":
      toggleExportTrack(current, (button.dataset.stem ?? null) as Track | null);
      updatePanels(current);
      return true;
    case "export-pick-all":
      toggleExportTrack(current, null);
      updatePanels(current);
      return true;
    case "export-format":
      setExportFormat(button.dataset.format === "wav" ? "wav" : "flac");
      updatePanels(current);
      return true;
    case "export-run": {
      const choice = exportChoice(current);
      if (choice.what === "chords") exportProjectChords(current, "txt");
      else if (choice.what === "mix") await exportMix(current);
      else await exportStems(current, choice.tracks);
      return true;
    }
    case "export-chords":
      exportProjectChords(current, button.dataset.format);
      return true;
    case "analyze":
      void analyzeProject(current);
      return true;
    case "tempo-factor":
      await editGrid(current, (edits) => {
        const factor = Math.max(
          MIN_BPM_FACTOR,
          Math.min(MAX_BPM_FACTOR, (edits.bpmFactor ?? 1) * Number(button.dataset.factor)),
        );
        return { ...edits, bpmFactor: factor === 1 ? undefined : factor };
      });
      return true;
    case "tempo-metre": {
      const metre = METRES.find((item) =>
        item.beats === Number(button.dataset.beats) && item.unit === Number(button.dataset.unit ?? 4)
      );
      if (!metre) return true;
      await editGrid(current, (edits) => ({ ...edits, beatsPerBar: undefined, metre: { ...metre } }));
      return true;
    }
    case "click-sub":
      await savePractice({ ...current, clickSubdivision: Number(button.dataset.sub) as ClickSubdivision });
      return true;
    case "count-in":
      await savePractice({ ...current, countInBars: Number(button.dataset.bars) as 0 | 1 | 2 });
      return true;
    case "capo-step":
      await savePractice({ ...current, capo: clampCapo((current.capo ?? 0) + Number(button.dataset.step)) });
      return true;
    case "capo-set":
      await savePractice({ ...current, capo: clampCapo(Number(button.dataset.capo)) });
      return true;
    case "capo-reset":
      await savePractice({ ...current, capo: 0 });
      return true;
    case "tempo-downbeat": {
      const step = Number(button.dataset.step);
      await editGrid(current, (edits) => ({ ...edits, downbeatShift: (edits.downbeatShift ?? 0) + step }));
      return true;
    }
    case "tempo-tap":
      await tap(current);
      return true;
    case "tempo-reset":
      taps = [];
      await editGrid(current, () => ({}));
      return true;
  }
  return false;
}

/** Slider moves apply at once; `handlePracticeChange` saves when released. */
export function handlePracticeInput(event: Event): boolean {
  const target = event.target as HTMLInputElement;
  const current = project();
  if (!current) return false;
  if (target.id === "seek-bar") {
    seekTo(Number(target.value));
    return true;
  }
  if (target.dataset.action === "volume" && target.dataset.stem) {
    const track = target.dataset.stem as Track;
    const value = Math.max(0, Math.min(1, Number(target.value) || 0));
    state.selectedProject = track === "click"
      ? { ...current, clickVolume: value }
      : { ...current, volumes: { ...current.volumes, [track]: value } };
    applyStemVolume(state.selectedProject, track);
    updateMixer(state.selectedProject);
    return true;
  }
  if (target.dataset.action === "speed") {
    void savePractice({ ...current, speed: clampSpeed(Number(target.value) / 100) }, false).catch(console.warn);
    return true;
  }
  return false;
}

export async function handlePracticeChange(event: Event): Promise<boolean> {
  const target = event.target as HTMLInputElement;
  const current = project();
  switch (target.dataset.action) {
    case "export-practice":
      setExportAppliesPractice(target.checked);
      if (current) updatePanels(current);
      return true;
  }
  if (!current) return false;
  switch (target.dataset.action) {
    case "key-select":
      await saveKeyOverride(current.id, parseKey(target.value));
      return true;
    case "chord-names": {
      const updated: Project = { ...current, chordNames: target.checked ? "transposed" : "original" };
      state.selectedProject = updated;
      updatePracticeDisplay(updated);
      const saved = await saveProject(updated);
      if (state.selectedProject === updated) state.selectedProject = saved;
      return true;
    }
    case "click-toggle":
      await toggleClick(current, target.checked);
      return true;
    case "click-accent":
      await savePractice({ ...current, clickAccent: target.checked });
      return true;
    case "volume":
      state.selectedProject = await saveProject(current);
      return true;
    case "speed":
      await savePractice({ ...current, speed: clampSpeed(Number(target.value) / 100) });
      return true;
  }
  if (target.id === "seek-bar") {
    seekTo(Number(target.value));
    return true;
  }
  return false;
}

/**
 * Practice shortcuts (desktop): Space plays or pauses, ← / → go to the
 * previous or next bar, ↑ / ↓ change the speed by 5 %, L turns the loop on
 * or off, Home goes back to the start, Esc closes a panel. Keys typed into
 * a field, or used on a focused slider, button or menu, keep their meaning.
 */
export async function handlePracticeKey(event: KeyboardEvent): Promise<void> {
  const field = event.target as HTMLElement;
  if (field.id === "marker-name" && event.key === "Enter" && project()) {
    event.preventDefault();
    await saveNewMarker(project()!);
    return;
  }
  if (event.key === "Escape" && openPanel()) {
    event.preventDefault();
    const opener = document.querySelector<HTMLElement>(`[data-action="panel"][data-panel="${openPanel()}"]`);
    setPanel(null);
    opener?.focus();
    return;
  }
  const current = project();
  if (!current) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target.closest("input, select, textarea, [contenteditable], dialog")) return;
  if (!playerTime().ready) return;
  const onButton = target.closest("button") !== null;
  switch (event.key) {
    case " ":
      if (onButton) return;
      event.preventDefault();
      await togglePlay(!isPlaying());
      break;
    case "ArrowLeft":
    case "ArrowRight":
      event.preventDefault();
      if (event.shiftKey) stepMarkers(current, event.key === "ArrowLeft" ? -1 : 1);
      else stepBars(current, event.key === "ArrowLeft" ? -1 : 1);
      break;
    case "m":
    case "M":
      if (!shownBars().length) return;
      event.preventDefault();
      prepareMarkerPanel();
      setPanel("marker");
      document.querySelector<HTMLElement>("#marker-name")?.focus();
      break;
    case "ArrowUp":
    case "ArrowDown":
      event.preventDefault();
      await stepSpeed(current, event.key === "ArrowUp" ? 1 : -1);
      break;
    case "Home":
      event.preventDefault();
      seekTo(0);
      break;
    case "l":
    case "L":
      event.preventDefault();
      await toggleLoop(current);
      break;
  }
}

/** A long press on the click button opens Rhythm (on phones). */
let longPressTimer = 0;
let longPressed = false;

export function installPracticeListeners(root: HTMLElement): void {
  root.addEventListener("pointerdown", (event) => {
    const markerElement = (event.target as HTMLElement).closest<HTMLElement>("[data-marker-bar]");
    if (markerElement && event.pointerType !== "mouse") {
      longPressed = false;
      clearTimeout(longPressTimer);
      longPressTimer = window.setTimeout(() => {
        longPressed = true;
        void markerMenu(Number(markerElement.dataset.markerBar)).catch(console.warn);
      }, 500);
      return;
    }
    const button = (event.target as HTMLElement).closest('[data-action="click-button"]');
    if (!button) return;
    longPressed = false;
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      longPressed = true;
      setPanel("rhythm");
    }, 500);
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
    root.addEventListener(type, () => {
      clearTimeout(longPressTimer);
      // Only the click that ends the long press is swallowed.
      if (longPressed) setTimeout(() => (longPressed = false), 400);
    });
  }
  root.addEventListener("contextmenu", (event) => {
    const markerElement = (event.target as HTMLElement).closest<HTMLElement>("[data-marker-bar]");
    if (markerElement) {
      event.preventDefault();
      // A long press on a phone opens the menu itself.
      if (!longPressed) void markerMenu(Number(markerElement.dataset.markerBar)).catch(console.warn);
      return;
    }
    if ((event.target as HTMLElement).closest('[data-action="click-button"]')) {
      event.preventDefault();
      setPanel("rhythm");
    }
  });
  // A click outside an open popover closes it. The click that ends a long
  // press is swallowed: it would land on the sheet's backdrop.
  document.addEventListener("click", (event) => {
    // (Not one in a dialog the long press opened, outside the page.)
    if (longPressed && root.contains(event.target as Node)) {
      longPressed = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!openPanel()) return;
    const target = event.target as HTMLElement;
    if (!target.isConnected) return;
    if (target.closest(".panel, [data-action='panel'], [data-action='click-button']")) return;
    setPanel(null);
  }, true);
}

/** Forgets loop helpers between projects. */
export function resetPracticeState(): void {
  taps = [];
  setPanel(null);
}
