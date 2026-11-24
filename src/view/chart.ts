import { barIndexAt, beatInBar, type ChartBar, chartBars, peakSlices } from "../analysis/chart";
import { nameChord } from "../analysis/chord-sheet";
import { playerTime } from "../player";
import { analysisStatus, cachedAnalysis, projectGrid } from "../tasks/analysis";
import type { ChordSegment, Project } from "../types";
import { escapeHtml, formatTime } from "./format";
import { chordNaming } from "./harmony";
import { icon } from "./icons";
import { sectionBars, sectionLoop } from "../markers";
import { songPeaks } from "./song-peaks";

/**
 * The chord chart: four bars a row (two rows side by side on desktop, so
 * eight a line), the song's peaks behind each bar, the bar playing
 * highlighted with its beats. Rebuilt only when what it shows changes;
 * the playhead moves in place.
 */

const BARS_PER_ROW = 4;
const PEAKS_PER_BAR = 14;

/** What the chart shows now: bars of the grid, or chords without one. */
let bars: ChartBar[] = [];
let segments: ChordSegment[] = [];
let shownKey = "";
let currentIndex = -2;

export function chartMarkup(): string {
  return `<section class="chord-chart" id="chord-chart" aria-label="Chord chart" tabindex="-1"></section>`;
}

/** The bars shown, for the player's bar label and shift-click loops. */
export function shownBars(): readonly ChartBar[] {
  return bars;
}

/** Rebuilds the chart if the analysis, naming, peaks or length changed. */
export function updateChart(project: Project): void {
  const chart = document.querySelector<HTMLElement>("#chord-chart");
  if (!chart) return;
  const record = cachedAnalysis(project.id);
  const status = analysisStatus(project.id);
  const grid = projectGrid(project.id);
  const duration = playerTime().duration || record?.duration || 0;
  const naming = chordNaming(project);
  const peaks = songPeaks(project);
  const key = [
    project.id,
    record === undefined ? "unknown" : record ? "record" : "none",
    status.running ? `running:${status.progress}` : "",
    status.error ?? "",
    record?.chords?.length ?? 0,
    record?.edits ? JSON.stringify(record.edits) : "",
    record?.keyOverride ? `${record.keyOverride.tonic}:${record.keyOverride.mode}` : "",
    grid?.beats.length ?? 0,
    grid?.firstDownbeat ?? "",
    naming.semitones,
    naming.key ? `${naming.key.tonic}:${naming.key.mode}` : "",
    peaks?.length ?? 0,
    Math.round(duration * 10),
    JSON.stringify(project.markers ?? []),
    project.loop ? `${project.loop.start}:${project.loop.end}:${project.loop.enabled}` : "",
  ].join("|");
  if (key === shownKey && chart.childElementCount) return;
  shownKey = key;
  currentIndex = -2;
  const chords = record?.chords ?? [];
  if (record && grid && duration > 0) {
    bars = chartBars(chords, grid, duration, naming);
    segments = [];
    chart.innerHTML = barsMarkup(bars, peaks, duration, project);
  } else if (record && chords.some((chord) => chord.root !== null)) {
    bars = [];
    segments = chords.filter((chord) => chord.root !== null);
    chart.innerHTML = segmentsMarkup(segments, project);
  } else {
    bars = [];
    segments = [];
    chart.innerHTML = emptyMarkup(project, record, status);
  }
  updateChartPlayhead();
}

function barsMarkup(list: ChartBar[], peaks: Float32Array | null, duration: number, project: Project): string {
  const markers = project.markers ?? [];
  const rows: string[] = [];
  // Rows of four bars, starting afresh at each marker, under its heading.
  let row: { bar: ChartBar; index: number }[] = [];
  const flush = () => {
    if (!row.length) return;
    rows.push(`<div class="chart-row">
      <span class="row-label" aria-hidden="true">${row[0].bar.number}</span>
      <div class="row-bars">${row.map(({ bar, index }) => barMarkup(bar, index, peaks, duration)).join("")}</div>
    </div>`);
    row = [];
  };
  list.forEach((bar, index) => {
    const markerIndex = markers.findIndex((marker) => marker.bar === bar.number);
    if (markerIndex >= 0) {
      flush();
      rows.push(sectionHeadMarkup(project, markerIndex, list));
    }
    row.push({ bar, index });
    if (row.length === BARS_PER_ROW) flush();
  });
  flush();
  return `<div class="chart-rows">${rows.join("")}</div>
    <p class="chart-hint">Click a bar to jump to it. Shift-click a bar to loop from the bar playing to that one.</p>`;
}

/** A marker's heading in the chart: jump to it, loop its section; right-click or long-press for more. */
function sectionHeadMarkup(project: Project, index: number, list: ChartBar[]): string {
  const markers = project.markers ?? [];
  const marker = markers[index];
  const { first, last } = sectionBars(markers, index, list[list.length - 1]?.number ?? marker.bar);
  const looped = sectionLooped(project, index, list);
  const name = escapeHtml(marker.name);
  return `<div class="section-head" data-marker-bar="${marker.bar}">
      <button class="section-jump" data-action="marker-jump" data-bar="${marker.bar}" aria-label="Jump to ${name}" title="Right-click or long-press to rename or delete">
        <span class="section-name">${name}</span><span class="section-meta">${first === last ? `Bar ${first}` : `Bars ${first}–${last}`}</span>
      </button>
      <span class="section-line" aria-hidden="true"></span>
      <button class="section-loop${looped ? " on" : ""}" data-action="marker-loop" data-bar="${marker.bar}" aria-pressed="${looped}" aria-label="Loop ${name}">${
    icon("loop", 14)
  }<span>${looped ? "Looping" : "Loop"}</span></button>
    </div>`;
}

/** Whether the project's loop is on and is this marker's section. */
export function sectionLooped(project: Project, index: number, list: readonly ChartBar[]): boolean {
  const loop = project.loop;
  if (!loop?.enabled) return false;
  const region = sectionLoop(project.markers ?? [], index, list);
  return region !== null && Math.abs(region.start - loop.start) < 0.01 && Math.abs(region.end - loop.end) < 0.01;
}

function barMarkup(bar: ChartBar, index: number, peaks: Float32Array | null, duration: number): string {
  const levels = peaks ? peakSlices(peaks, duration, bar.start, bar.end, PEAKS_PER_BAR) : [];
  const names = bar.chords.join(" ");
  const label = `Bar ${bar.number}, ${names === "N.C." ? "no chord" : names}, ${formatTime(bar.start)}`;
  return `<button class="bar-cell${names === "N.C." ? " rest" : ""}" data-action="bar-seek" data-index="${index}" aria-label="${
    escapeHtml(label)
  }">
      <span class="bar-peaks" aria-hidden="true">${
    levels.map((level) => `<span style="height:${Math.max(6, Math.round(level * 100))}%"></span>`).join("")
  }</span>
      <span class="bar-chord${bar.chords.length > 1 ? " split" : ""}">${
    bar.chords.map((name) => `<span>${escapeHtml(name)}</span>`).join("")
  }</span>
      <span class="bar-beats" aria-hidden="true"></span>
    </button>`;
}

/** No beat grid: the chords in time order, each with its start time. */
function segmentsMarkup(list: ChordSegment[], project: Project): string {
  const naming = chordNaming(project);
  return `<p class="chart-note">${icon("music", 16)}<span>No steady beat was found, so there are no bars. Tap the tempo in Rhythm to make a grid.</span></p>
    <div class="segment-grid">${
    list.map((chord, index) => {
      const name = nameChord(chord, naming);
      return `<button class="bar-cell segment" data-action="chord-seek" data-index="${index}" aria-label="${
        escapeHtml(`${name} at ${formatTime(chord.start)}`)
      }"><span class="bar-chord"><span>${escapeHtml(name)}</span></span><small>${formatTime(chord.start)}</small></button>`;
    }).join("")
  }</div>`;
}

function emptyMarkup(
  project: Project,
  record: ReturnType<typeof cachedAnalysis>,
  status: ReturnType<typeof analysisStatus>,
): string {
  if (status.running || (record === undefined && !status.error)) {
    return `<div class="chart-empty" role="status">
      <span class="chart-spinner" aria-hidden="true"></span>
      <strong>Detecting tempo, beats, key and chords${status.running ? ` · ${status.progress}%` : "…"}</strong>
      <span class="muted">The chord chart appears when it is done. You can play and mix meanwhile.</span>
    </div>`;
  }
  if (status.error) {
    return `<div class="chart-empty" role="status">
      <strong>The chords couldn't be detected</strong>
      <span class="muted">${escapeHtml(status.error)}</span>
      <button class="button small" data-action="analyze">Try again</button>
    </div>`;
  }
  if (!record) {
    return `<div class="chart-empty" role="status">
      <strong>No chords yet</strong>
      <button class="button small" data-action="analyze">Detect tempo, beats, key and chords</button>
    </div>`;
  }
  return `<div class="chart-empty" role="status">
      <strong>No chords or beats found</strong>
      <span class="muted">The stems other than drums are silent${projectGrid(project.id) ? "" : " and there is no steady beat"}. Tap the tempo in Rhythm to make a grid.</span>
    </div>`;
}

/** The bar a chart cell stands for (null for a chord without a grid). */
export function barForCell(cell: HTMLElement): ChartBar | null {
  return bars[Number(cell.dataset.index)] ?? null;
}

/** The chord a cell stands for, when the chart has no grid. */
export function segmentForCell(cell: HTMLElement): ChordSegment | null {
  return segments[Number(cell.dataset.index)] ?? null;
}

/** The bar playing, if the chart shows bars. */
export function currentBar(): ChartBar | null {
  const index = barIndexAt(bars, playerTime().position);
  return index >= 0 ? bars[index] : null;
}

/**
 * Highlights the bar playing and its beat (called on player ticks and every
 * frame while playing), keeping it in view while playing.
 */
export function updateChartPlayhead(projectId?: string): void {
  const chart = document.querySelector<HTMLElement>("#chord-chart");
  if (!chart) return;
  const { position, playing } = playerTime();
  if (bars.length) {
    const index = barIndexAt(bars, position);
    const cells = chart.querySelectorAll<HTMLElement>(".bar-cell");
    if (index !== currentIndex) {
      cells[currentIndex]?.classList.remove("current");
      cells[currentIndex]?.removeAttribute("aria-current");
      const old = cells[currentIndex]?.querySelector(".bar-beats");
      if (old) old.innerHTML = "";
      currentIndex = index;
      const cell = cells[index];
      if (cell) {
        cell.classList.add("current");
        cell.setAttribute("aria-current", "true");
        if (playing) cell.scrollIntoView({ block: "nearest" });
      }
    }
    const cell = cells[index];
    const grid = projectId ? projectGrid(projectId) : null;
    if (cell && grid) {
      const beat = beatInBar(grid, position);
      const holder = cell.querySelector<HTMLElement>(".bar-beats")!;
      if (holder.childElementCount !== grid.beatsPerBar) {
        holder.innerHTML = "<span></span>".repeat(grid.beatsPerBar);
      }
      holder.querySelectorAll("span").forEach((span, i) => span.classList.toggle("on", i <= beat));
    }
  } else if (segments.length) {
    let index = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= position) index = i;
      else break;
    }
    if (index !== currentIndex) {
      const cells = chart.querySelectorAll<HTMLElement>(".bar-cell");
      cells[currentIndex]?.classList.remove("current");
      currentIndex = index;
      cells[index]?.classList.add("current");
      if (playing) cells[index]?.scrollIntoView({ block: "nearest" });
    }
  }
}

/** Forgets what the chart showed, so the next update rebuilds it. */
export function resetChart(): void {
  shownKey = "";
  currentIndex = -2;
}
