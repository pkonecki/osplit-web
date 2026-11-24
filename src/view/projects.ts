import { connection } from "../cloud/cloud";
import { keyName } from "../analysis/spelling";
import {
  LIBRARY_FILTERS,
  type LibraryFilter,
  matchesFilter,
  matchesQuery,
  openedTimes,
  type ProjectKind,
  projectKind,
  relativeTime,
  sortProjects,
} from "../library";
import { state } from "../state";
import { getAnalysis, getPeaks, storageEstimate } from "../storage";
import { MODEL_STEMS, type Project, projectModel } from "../types";
import { remoteRowMarkup, syncIcon, syncLineMarkup, syncState } from "./cloud";
import { cloud, remoteOnlyProjects } from "../cloud/cloud";
import { fileInputMarkup, messageMarkup } from "./detail";
import { escapeHtml, formatBytes } from "./format";
import { songKey } from "./harmony";
import { icon } from "./icons";
import { footerMarkup, pageHeader } from "./shell";

/** Search and filter, kept while the app is open. */
export const library = {
  query: "",
  filter: "all" as LibraryFilter,
};

export async function renderProjects(): Promise<string> {
  const estimate = await storageEstimate();
  const cloud = connection();
  const projects = sortProjects(state.projects, openedTimes());
  const rows = await Promise.all(projects.map(projectRow));
  // Projects only in the cloud, to download.
  rows.push(...(await remoteOnlyProjects()).map(remoteRowMarkup));
  const disabled = state.working ? "disabled" : "";
  const storage = estimate?.usage !== undefined
    ? `${formatBytes(estimate.usage)}${estimate.quota ? ` of ${formatBytes(estimate.quota)}` : ""}`
    : "";
  return `
    <main class="content library">
      ${pageHeader("Library", {
    subtitle: cloud
      ? `Separation runs on this device. Projects sync with your ${escapeHtml(cloud.label)}.`
      : "Separation runs on this device. Your audio and projects stay in this browser.",
    actions: `
          <button class="button subtle with-icon desktop-only" data-action="import-project">${
      icon("importFile", 18)
    }Import project file</button>
          <button class="button primary with-icon desktop-only" data-action="new-split" ${disabled}>${
      icon("plus", 18)
    }New split</button>
          <button class="icon-button mobile-only" data-action="import-project" aria-label="Import project file">${
      icon("importFile", 22)
    }</button>
          <button class="icon-button mobile-only" data-action="settings" aria-label="Settings" ${disabled}>${
      icon("settings", 22)
    }</button>`,
  })}
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
      ${
    projects.length
      ? `
      <button class="drop-zone desktop-only" data-action="new-split" ${disabled}>
        <span class="drop-zone-icon">${icon("upload", 22)}</span>
        <span><strong>Drop an audio file anywhere to start a split</strong>
        <small>MP3, WAV, FLAC, M4A or OGG · or paste a link</small></span>
      </button>
      <div class="library-tools">
        <label class="search-field">${icon("search", 16)}<input id="library-search" type="search" placeholder="Search projects" aria-label="Search projects" value="${
        escapeHtml(library.query)
      }" autocomplete="off" /></label>
        <div class="filter-chips" role="group" aria-label="Filter">${
        LIBRARY_FILTERS.map((filter) =>
          `<button class="chip${library.filter === filter.id ? " on" : ""}" data-action="library-filter" data-filter="${filter.id}" aria-pressed="${
            library.filter === filter.id
          }">${filter.label}</button>`
        ).join("")
      }</div>
        ${syncLineMarkup()}
        ${
        storage
          ? `<span class="library-storage" title="Browser storage used by OSplit">${
            icon("device", 15)
          }<span>${storage}</span></span>`
          : ""
      }
      </div>`
      : ""
  }
      ${
    rows.length
      ? `<section class="project-list" aria-label="Projects">${rows.join("")}</section>
         <p class="no-results muted" hidden>No projects match.</p>`
      : emptyLibraryMarkup()
  }
      <p class="notice">Separation keeps running while this tab is open. If the browser stops it, the project is saved and you can resume.</p>
      ${footerMarkup()}
    </main>
    <button class="fab mobile-only" data-action="new-split" ${disabled}>${icon("plus", 20)}New split</button>
    ${fileInputMarkup()}
  `;
}

/** First launch: nothing to list yet. */
function emptyLibraryMarkup(): string {
  return `
    <section class="empty-library">
      <span class="empty-wave" aria-hidden="true">${icon("logo", 36)}</span>
      <h2>Your library is empty</h2>
      <p class="muted">Split a song into stems to practise with it: vocals, drums, bass and more. Everything runs on this device.</p>
      <div class="empty-actions">
        <button class="button primary with-icon" data-action="new-split" ${
    state.working ? "disabled" : ""
  }>${icon("plus", 18)}New split</button>
        <button class="button subtle" data-action="import-project">Import project file</button>
      </div>
      <p class="muted drop-hint desktop-only">Or drop an audio file anywhere on this page.</p>
    </section>`;
}

/** What a row shows that needs storage reads, cached per project version. */
interface RowExtras {
  updatedAt: number;
  music: string;
  thumb: number[];
}
const extrasCache = new Map<string, RowExtras>();

async function rowExtras(project: Project): Promise<RowExtras> {
  const cached = extrasCache.get(project.id);
  if (cached && cached.updatedAt === project.updatedAt) return cached;
  const [record, peaks] = project.completedStems.length
    ? await Promise.all([getAnalysis(project.id).catch(() => undefined), getPeaks(project.id).catch(() => ({}))])
    : [undefined, {}];
  const parts: string[] = [];
  const key = songKey(record);
  if (key) parts.push(keyName(key));
  if (record && record.beats.length > 1) {
    const bpm = record.edits?.tapped?.bpm ?? record.bpm * (record.edits?.bpmFactor ?? 1);
    if (bpm > 0) parts.push(`${Math.round(bpm)} BPM`);
  }
  const extras = { updatedAt: project.updatedAt, music: parts.join(" · "), thumb: thumbnail(Object.values(peaks)) };
  extrasCache.set(project.id, extras);
  return extras;
}

/** Twelve bar heights (0–1): the loudest stem in each twelfth of the song. */
export function thumbnail(peaks: Float32Array[], bars = 12): number[] {
  const length = Math.max(0, ...peaks.map((values) => values.length));
  if (!length) return [];
  const heights: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const from = Math.floor((bar / bars) * length);
    const to = Math.max(from + 1, Math.floor(((bar + 1) / bars) * length));
    let peak = 0;
    for (const values of peaks) {
      for (let i = from; i < to && i < values.length; i++) peak = Math.max(peak, Math.abs(values[i]));
    }
    heights.push(peak);
  }
  const top = Math.max(...heights) || 1;
  return heights.map((height) => height / top);
}

const STATUS_TEXT: Record<ProjectKind, string> = {
  ready: "Ready",
  busy: "Separating",
  interrupted: "Interrupted",
  failed: "Failed",
  empty: "Empty",
  cloud: "In the cloud only",
};

async function projectRow(project: Project): Promise<string> {
  const extras = await rowExtras(project);
  const kind = projectKind(project);
  const id = escapeHtml(project.id);
  const name = escapeHtml(project.name);
  const model = projectModel(project);
  const modelText = kind === "empty" && !project.sourceName
    ? "—"
    : `${model === "htdemucs-6s" ? "Demucs" : "Spleeter"} · ${MODEL_STEMS[model].length} stems`;
  const progress = Math.round(project.taskProgress ?? 0);
  let status = STATUS_TEXT[kind];
  if (kind === "busy") {
    status = `Separating · ${Math.round(state.taskProjectId === project.id ? state.progress : progress)}%`;
  }
  if (kind === "interrupted" && progress > 0) status = `Interrupted at ${progress}%`;
  if (kind === "empty" && project.sourceName) status = "Not split yet";
  const source = project.sourceName ?? "No audio yet";
  const when = relativeTime(openedTimes()[project.id] ?? project.updatedAt);
  const sync = syncState(project);
  const action = kind === "interrupted" || kind === "failed"
    ? `<button class="button small" data-action="resume" data-id="${id}" ${
      state.working || !project.sourceName || project.sourceRemoved ? "disabled" : ""
    } aria-label="Resume ${name}">${kind === "failed" ? "Retry" : "Resume"}</button>`
    : kind === "busy"
    ? `<button class="button small" data-action="open" data-id="${id}" aria-label="Open ${name}">Open</button>`
    : kind === "empty"
    ? `<button class="button small" data-action="open" data-id="${id}" aria-label="${
      project.sourceName ? "Split" : "Add audio to"
    } ${name}">${project.sourceName ? "Split" : "Add audio"}</button>`
    : "";
  const search = `${project.name} ${project.sourceName ?? ""}`;
  return `
    <article class="project-row kind-${kind}${state.taskProjectId === project.id ? " here" : ""}" data-kind="${kind}" data-search="${escapeHtml(search)}">
      <button class="project-open" data-action="open" data-id="${id}">
        <span class="project-thumb" aria-hidden="true">${
    extras.thumb.length
      ? extras.thumb.map((height) => `<span style="height:${Math.max(8, Math.round(height * 100))}%"></span>`).join("")
      : icon("music", 20)
  }</span>
        <span class="project-summary">
          <strong>${name}</strong>
          <small>${escapeHtml(source)} · ${escapeHtml(when)}</small>
          <small class="mobile-meta">${escapeHtml([modelText === "—" ? "" : modelText, extras.music].filter(Boolean).join(" · "))}</small>
        </span>
      </button>
      <span class="project-model">${escapeHtml(modelText)}</span>
      <span class="project-music">${escapeHtml(extras.music || "—")}</span>
      ${
    sync
      ? `<span class="project-sync sync-${sync.state}" title="${escapeHtml(sync.label)}">${syncIcon(sync.state)}<span>${
        escapeHtml(sync.label)
      }</span></span>`
      : ""
  }
      <span class="project-status">
        <span class="status-text">${escapeHtml(status)}</span>
        ${
    kind === "busy" || (kind === "interrupted" && progress > 0)
      ? `<span class="status-bar" aria-hidden="true"><span style="width:${
        Math.round(state.taskProjectId === project.id ? state.progress : progress)
      }%"></span></span>`
      : ""
  }
      </span>
      <span class="project-actions">
        ${action}
        ${syncActions(project, sync?.state ?? null, name, id)}
        <button class="icon-button row-menu" data-action="project-menu" data-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${name}">${
    icon("more", 20)
  }</button>
      </span>
    </article>
  `;
}

/** Upload, Download or Resolve on a row, by its sync state. */
function syncActions(project: Project, state: string | null, name: string, id: string): string {
  const busy = cloud.busy ? "disabled" : "";
  const ready = project.completedStems.length > 0 && project.status !== "processing";
  if (state === "conflict") {
    return `<button class="button small danger-line" data-action="cloud-resolve" data-id="${id}" ${busy} aria-label="Resolve ${name}">Resolve</button>`;
  }
  if (state === "local" && ready) {
    return `<button class="button small with-icon" data-action="cloud-upload" data-id="${id}" ${busy} aria-label="Upload ${name} to the cloud">${
      icon("upload", 16)
    }Upload</button>`;
  }
  return "";
}

/** Shows only the rows matching the search and filter, in place. */
export function applyLibraryFilter(): void {
  const rows = document.querySelectorAll<HTMLElement>(".project-row");
  let shown = 0;
  for (const row of rows) {
    const visible = matchesFilter(row.dataset.kind as ProjectKind, library.filter) &&
      matchesQuery(row.dataset.search ?? "", library.query);
    row.hidden = !visible;
    if (visible) shown++;
  }
  const none = document.querySelector<HTMLElement>(".no-results");
  if (none) none.hidden = shown > 0 || rows.length === 0;
  for (const chip of document.querySelectorAll<HTMLElement>('[data-action="library-filter"]')) {
    const on = chip.dataset.filter === library.filter;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}
