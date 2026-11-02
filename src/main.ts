import "./style.css";
import { mixWavBlobs, resampleStereo } from "./audio-core";
import {
  completeSeparation,
  deleteProject,
  getProject,
  getSource,
  getStem,
  isQuotaError,
  listProjects,
  replaceSource,
  requestPersistentStorage,
  saveProject,
  storageEstimate,
  updateProjectTask,
} from "./storage";
import {
  newProject,
  type Project,
  type ProjectStatus,
  type Quality,
  type Stem,
  STEM_LABELS,
  STEMS,
} from "./types";

type InferenceMessage =
  | { type: "progress"; id: string; stage: string; progress: number }
  | { type: "complete"; id: string; stems: Record<Stem, Blob> }
  | { type: "cancelled"; id: string }
  | { type: "error"; id: string; message: string };

type UrlMessage =
  | { type: "progress"; id: string; progress: number; stage: string }
  | { type: "downloaded"; id: string; name: string; blob: Blob }
  | { type: "updated"; id: string; version: string }
  | { type: "error"; id: string; message: string };

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("The app root element is missing.");

let projects: Project[] = [];
let selectedProject: Project | null = null;
let progress = 0;
let progressLabel = "";
let screenMessage = "";
let working = false;
let inferenceWorker: Worker | undefined;
let urlWorker: Worker | undefined;
let rejectInference: ((error: Error) => void) | undefined;
let rejectUrlDownload: ((error: Error) => void) | undefined;
let abortSeparation = false;
let playerProjectId: string | null = null;
const players = new Map<Stem, HTMLAudioElement>();
const objectUrls = new Map<Stem, string>();
let progressTimer: number | undefined;
let fileDialogTarget: "source" | "none" = "none";

void start();

async function start(): Promise<void> {
  registerServiceWorker();
  try {
    projects = await listProjects();
    for (const project of projects) {
      if (project.status === "processing") {
        await saveProject({
          ...project,
          status: "interrupted",
          errorMessage:
            "The browser stopped the previous task. Start separation again to retry.",
        });
      }
    }
    projects = await listProjects();
    const lastId = localStorage.getItem("osplit-web-last-project");
    selectedProject = projects.find((project) => project.id === lastId) ?? null;
    await render();
    void requestPersistentStorage();
  } catch (error) {
    showFatal(error);
  }
}

function cancelUrlDownload(): void {
  if (!working || !urlWorker) return;
  urlWorker.terminate();
  rejectUrlDownload?.(new DOMException("Download cancelled.", "AbortError"));
}

function registerServiceWorker(): void {
  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" || location.hostname === "localhost")
  ) {
    void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("Offline app shell could not be registered.", error);
    });
  }
}

async function render(): Promise<void> {
  projects = await listProjects();
  if (selectedProject) {
    selectedProject = projects.find((project) =>
      project.id === selectedProject?.id
    ) ?? null;
  }
  if (selectedProject) {
    root!.innerHTML = renderDetail(selectedProject);
    await preparePlayers(selectedProject);
  } else {
    releasePlayers();
    root!.innerHTML = await renderProjects();
  }
}

async function renderProjects(): Promise<string> {
  const estimate = await storageEstimate();
  const used = estimate?.usage ? formatBytes(estimate.usage) : "unknown";
  const total = estimate?.quota
    ? formatBytes(estimate.quota)
    : "browser managed";
  const updateLabel = working
    ? "Checking / updating yt-dlp…"
    : "Check yt-dlp update";
  return `
    <header class="topbar">
      <a class="brand" href="#" aria-label="OSplit home">
        <span class="brand-mark"><img src="/icon.svg" alt="" /></span>
        <span><strong>OSPLIT</strong><small>ON-DEVICE STEM STUDIO</small></span>
      </a>
      <button class="button subtle" data-action="yt-update" ${
    working ? "disabled" : ""
  }>${updateLabel}</button>
    </header>
    <main class="layout">
      <section class="intro">
        <p class="eyebrow">LOCAL STEM STUDIO</p>
        <h1>Your projects</h1>
        <p class="muted">Separate audio into vocals, piano, drums, bass, and other. Your audio and projects stay in this browser.</p>
        <div class="storage-note">Browser storage: ${used} used · ${total} available. Models are downloaded only when first needed.</div>
      </section>
      ${screenMessage ? messageMarkup(screenMessage) : ""}
      <section class="create-card">
        <label for="new-project-name">Create a project</label>
        <div class="form-row">
          <input id="new-project-name" maxlength="80" placeholder="Project name (optional)" />
          <button class="button primary" data-action="create">Create project</button>
        </div>
      </section>
      <div class="section-heading"><h2>Saved projects</h2><span class="muted">${projects.length}</span></div>
      ${
    projects.length
      ? `<section class="project-list">${
        projects.map(projectCard).join("")
      }</section>`
      : `<section class="empty-card"><span class="empty-wave">▂ ▅ ▇ ▅ ▂</span><h3>No projects yet</h3><p class="muted">Create a project first. You can add audio or URL input at any time.</p></section>`
  }
      <p class="notice">Processing runs locally while this app is open. If the browser stops it, project state is saved and you can retry.</p>
    </main>
    <footer>OSplit Web · local-only projects · <a href="/README-web.html">Browser limitations</a></footer>
    ${fileInputMarkup()}
  `;
}

function projectCard(project: Project): string {
  return `
    <article class="project-card">
      <button class="project-open" data-action="open" data-id="${
    escapeHtml(project.id)
  }">
        <span class="project-symbol">♫</span>
        <span class="project-summary">
          <strong>${escapeHtml(project.name)}</strong>
          <small>${escapeHtml(project.sourceName ?? "No audio source")} · ${
    escapeHtml(statusLabel(project.status))
  }</small>
        </span>
      </button>
      <button class="button danger-quiet" data-action="delete" data-id="${
    escapeHtml(project.id)
  }">Delete</button>
    </article>
  `;
}

function renderDetail(project: Project): string {
  const complete = project.completedStems.length > 0;
  const busy = working || project.status === "processing";
  return `
    <header class="topbar">
      <button class="brand brand-button" data-action="home">
        <span class="brand-mark"><img src="/icon.svg" alt="" /></span>
        <span><strong>OSPLIT</strong><small>ON-DEVICE STEM STUDIO</small></span>
      </button>
      <button class="button subtle" data-action="home" ${
    working ? "disabled" : ""
  }>Projects</button>
    </header>
    <main class="layout detail">
      ${screenMessage ? messageMarkup(screenMessage) : ""}
      <section class="project-heading">
        <p class="eyebrow">PROJECT</p>
        <h1>${escapeHtml(project.name)}</h1>
        <p class="muted">Saved in this browser · ${
    escapeHtml(project.sourceName ?? "No audio source yet")
  }</p>
      </section>
      <section class="source-row">
        <button class="button secondary" data-action="import" ${
    busy ? "disabled" : ""
  }>Choose audio file</button>
        <div class="url-input"><input id="media-url" type="url" inputmode="url" placeholder="https://… (best effort)" aria-label="Audio or video URL" /><button class="button secondary" data-action="download-url" ${
    busy ? "disabled" : ""
  }>Download URL</button></div>
        ${
    urlWorker
      ? `<button class="button outline" data-action="cancel">Cancel download</button>`
      : ""
  }
      </section>
      <p class="hint">URL download runs entirely in your browser and works only when the provider permits browser access. YouTube and many sites block this; importing a local audio file is the reliable option.</p>
      <section class="quality-row">
        <div><h2>Model quality</h2><p class="muted">Models are downloaded and cached on first use.</p></div>
        <div class="quality-buttons">
          <button class="quality ${
    project.quality === "fp32" ? "selected" : ""
  }" data-action="quality" data-quality="fp32" ${
    busy ? "disabled" : ""
  }>High quality <small>FP32 · 197 MB</small></button>
          <button class="quality ${
    project.quality === "fp16" ? "selected" : ""
  }" data-action="quality" data-quality="fp16" ${
    busy ? "disabled" : ""
  }>Low quality <small>FP16 · 98 MB</small></button>
        </div>
      </section>
      ${
    project.sourceName
      ? `<section class="process-card">
              <button class="button primary" data-action="${
        busy ? "cancel" : "separate"
      }">${
        urlWorker
          ? "Cancel download"
          : busy
          ? "Cancel processing"
          : complete
          ? "Separate again"
          : project.status === "interrupted"
          ? "Retry separation"
          : "Separate five stems"
      }</button>
              <div class="progress-track"><span style="width:${
        Math.max(0, Math.min(100, progress))
      }%"></span></div>
              <div class="progress-copy"><span>${
        escapeHtml(progressLabel || statusLabel(project.status))
      }</span><span>${busy ? `${progress}%` : ""}</span></div>
              ${project.errorMessage ? messageMarkup(project.errorMessage) : ""}
            </section>`
      : `<section class="empty-card compact"><h3>Add a source track</h3><p class="muted">Choose an audio file from this device to enable separation.</p></section>`
  }
      ${complete ? renderMixer(project) : ""}
      <p class="notice">The browser may suspend processing when this tab is in the background. Task status is saved, but work is not guaranteed to continue after the tab is closed.</p>
    </main>
    <footer>OSplit Web · IndexedDB local storage · <a href="/README-web.html">Browser limitations</a></footer>
    ${fileInputMarkup()}
  `;
}

function renderMixer(project: Project): string {
  const time = playerTime();
  return `
    <section class="mixer-card">
      <div class="mixer-title">
        <h2>Project player &amp; mixer</h2>
        <button class="button outline" data-action="export-mix">Export full mix</button>
      </div>
      <div class="player-row">
        <button class="play-button" data-action="play" aria-label="${
    time.playing ? "Pause" : "Play"
  }">${time.playing ? "Ⅱ" : "▶"}</button>
        <div class="seek-area">
          <input id="seek-bar" type="range" min="0" max="${time.duration}" value="${time.position}" ${
    time.duration ? "" : "disabled"
  } aria-label="Seek" />
          <div class="time-row"><span id="current-time">${
    formatTime(time.position)
  }</span><span id="total-time">${formatTime(time.duration)}</span></div>
        </div>
      </div>
      <div class="stem-list">
        ${
    STEMS.filter((stem) => project.completedStems.includes(stem)).map((
      stem,
    ) => `
          <div class="stem-control">
            <span class="stem-label">${STEM_LABELS[stem]}</span>
            <input type="range" min="0" max="1" step="0.01" value="${
      project.volumes[stem]
    }" data-action="volume" data-stem="${stem}" aria-label="${
      STEM_LABELS[stem]
    } volume" ${project.mutedStems.includes(stem) ? "disabled" : ""} />
            <button class="mute-button ${
      project.mutedStems.includes(stem) ? "muted" : ""
    }" data-action="mute" data-stem="${stem}" aria-label="${
      project.mutedStems.includes(stem) ? "Unmute" : "Mute"
    } ${STEM_LABELS[stem]}">${
      project.mutedStems.includes(stem) ? "◖×" : "◖))"
    }</button>
            <button class="button text-button" data-action="export-stem" data-stem="${stem}">Export</button>
          </div>
        `).join("")
  }
      </div>
    </section>
  `;
}

function fileInputMarkup(): string {
  return `<input id="audio-file" type="file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus,.webm" hidden />`;
}

function messageMarkup(message: string): string {
  return `<div class="message" role="status"><span>${
    escapeHtml(message)
  }</span><button data-action="dismiss" aria-label="Dismiss">×</button></div>`;
}

function playerTime(): {
  position: number;
  duration: number;
  playing: boolean;
} {
  const first = players.values().next().value as HTMLAudioElement | undefined;
  return {
    position: first?.currentTime ?? 0,
    duration: Number.isFinite(first?.duration) ? first!.duration : 0,
    playing: [...players.values()].some((player) => !player.paused),
  };
}

async function preparePlayers(project: Project): Promise<void> {
  if (!project.completedStems.length || playerProjectId === project.id) return;
  releasePlayers();
  const entries = await Promise.all(project.completedStems.map(async (stem) => {
    const stored = await getStem(project.id, stem);
    if (!stored) {
      throw new Error(`The saved ${STEM_LABELS[stem]} audio is missing.`);
    }
    const url = URL.createObjectURL(stored.blob);
    const player = new Audio(url);
    player.preload = "auto";
    player.volume = project.mutedStems.includes(stem)
      ? 0
      : project.volumes[stem];
    player.addEventListener("ended", () => pauseAll());
    players.set(stem, player);
    objectUrls.set(stem, url);
    return player;
  }));
  playerProjectId = project.id;
  if (entries.length) {
    progressTimer = window.setInterval(updatePlayerDisplay, 250);
  }
}

function releasePlayers(): void {
  if (progressTimer !== undefined) window.clearInterval(progressTimer);
  progressTimer = undefined;
  players.forEach((player) => {
    player.pause();
    player.removeAttribute("src");
    player.load();
  });
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  players.clear();
  objectUrls.clear();
  playerProjectId = null;
}

function updatePlayerDisplay(): void {
  const range = document.querySelector<HTMLInputElement>("#seek-bar");
  const current = document.querySelector<HTMLElement>("#current-time");
  const total = document.querySelector<HTMLElement>("#total-time");
  const play = document.querySelector<HTMLButtonElement>(
    '[data-action="play"]',
  );
  if (!range || !current || !total || !play) return;
  const time = playerTime();
  if (document.activeElement !== range) range.value = String(time.position);
  range.max = String(time.duration);
  current.textContent = formatTime(time.position);
  total.textContent = formatTime(time.duration);
  play.textContent = time.playing ? "Ⅱ" : "▶";
  play.setAttribute("aria-label", time.playing ? "Pause" : "Play");
}

async function pauseAll(): Promise<void> {
  players.forEach((player) => player.pause());
}

async function handleClick(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-action]",
  );
  if (!button || button.getAttribute("aria-disabled") === "true") return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  try {
    switch (action) {
      case "create": {
        const name =
          document.querySelector<HTMLInputElement>("#new-project-name")
            ?.value ?? "";
        selectedProject = await saveProject(newProject(name));
        localStorage.setItem("osplit-web-last-project", selectedProject.id);
        screenMessage = "";
        await render();
        break;
      }
      case "open":
        selectedProject = (await getProject(id ?? "")) ?? null;
        if (!selectedProject) throw new Error("That project no longer exists.");
        localStorage.setItem("osplit-web-last-project", selectedProject.id);
        await render();
        break;
      case "home":
        if (working) {
          throw new Error(
            "Wait for the current task or cancel it before leaving this project.",
          );
        }
        selectedProject = null;
        localStorage.removeItem("osplit-web-last-project");
        screenMessage = "";
        await render();
        break;
      case "delete":
        if (
          id &&
          confirm("Delete this project and all its source audio and stems?")
        ) {
          await deleteProject(id);
          if (selectedProject?.id === id) selectedProject = null;
          await render();
        }
        break;
      case "import":
        fileDialogTarget = "source";
        document.querySelector<HTMLInputElement>("#audio-file")?.click();
        break;
      case "quality":
        if (selectedProject && button.dataset.quality) {
          selectedProject = await saveProject({
            ...selectedProject,
            quality: button.dataset.quality as Quality,
          });
          await render();
        }
        break;
      case "separate":
        if (selectedProject) void separateProject(selectedProject);
        break;
      case "cancel":
        if (urlWorker) cancelUrlDownload();
        else cancelSeparation();
        break;
      case "download-url":
        if (selectedProject) await downloadFromUrl(selectedProject);
        break;
      case "yt-update":
        await checkYtDlpUpdate();
        break;
      case "dismiss":
        screenMessage = "";
        await render();
        break;
      case "play":
        if ([...players.values()].some((player) => !player.paused)) {
          await pauseAll();
        } else await playAll();
        updatePlayerDisplay();
        break;
      case "mute":
        if (selectedProject && button.dataset.stem) {
          await toggleMute(selectedProject, button.dataset.stem as Stem);
        }
        break;
      case "export-stem":
        if (selectedProject && button.dataset.stem) {
          await exportStem(selectedProject, button.dataset.stem as Stem);
        }
        break;
      case "export-mix":
        if (selectedProject) await exportMix(selectedProject);
        break;
    }
  } catch (error) {
    screenMessage = describeError(error);
    await render();
  }
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || fileDialogTarget !== "source" || !selectedProject) return;
  fileDialogTarget = "none";
  try {
    selectedProject = await replaceSource(selectedProject, file, file.name);
    screenMessage = "";
    await render();
  } catch (error) {
    screenMessage = describeError(error);
    await render();
  }
}

async function separateProject(project: Project): Promise<void> {
  if (working) return;
  const source = await getSource(project.id);
  if (!source) {
    throw new Error("Import a local audio file before separating stems.");
  }
  working = true;
  abortSeparation = false;
  progress = 0;
  progressLabel = "Preparing audio";
  selectedProject = await updateProjectTask(project.id, {
    status: "processing",
    errorMessage: null,
    taskProgress: 0,
    taskStage: "Preparing audio",
  });
  await render();

  try {
    const audioContext = new AudioContext({ sampleRate: 44_100 });
    let decoded: AudioBuffer;
    try {
      decoded = await audioContext.decodeAudioData(
        await source.blob.arrayBuffer(),
      );
    } finally {
      await audioContext.close();
    }
    if (abortSeparation) {
      throw new DOMException("Separation cancelled.", "AbortError");
    }
    const left = decoded.getChannelData(0).slice();
    const right = decoded.numberOfChannels > 1
      ? decoded.getChannelData(1).slice()
      : left.slice();
    const samples = resampleStereo(left, right, decoded.sampleRate);
    const id = crypto.randomUUID();
    const worker = new Worker(
      new URL("./inference.worker.ts", import.meta.url),
      { type: "module" },
    );
    inferenceWorker = worker;

    const stems = await new Promise<Record<Stem, Blob>>((resolve, reject) => {
      rejectInference = reject;
      worker.onmessage = (event: MessageEvent<InferenceMessage>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          progress = message.progress;
          progressLabel = message.stage;
          void updateProjectTask(project.id, {
            status: "processing",
            taskProgress: message.progress,
            taskStage: message.stage,
          }).then((updated) => {
            if (selectedProject?.id === updated.id) selectedProject = updated;
          }).catch((error: unknown) => {
            screenMessage = `Could not save task progress: ${
              describeError(error)
            }`;
            void render();
          });
          updateProgressDisplay();
        } else if (message.type === "complete") {
          resolve(message.stems);
        } else if (message.type === "cancelled") {
          reject(new DOMException("Separation cancelled.", "AbortError"));
        } else {
          reject(new Error(message.message));
        }
      };
      worker.onerror = (error) =>
        reject(new Error(error.message || "The inference worker failed."));
      worker.postMessage({
        type: "separate",
        id,
        quality: project.quality,
        samples,
      }, [samples.buffer]);
    });

    selectedProject = await completeSeparation(project.id, stems);
    progressLabel = "Separation complete";
  } catch (error) {
    const cancelled = error instanceof DOMException &&
      error.name === "AbortError";
    selectedProject = await updateProjectTask(project.id, {
      status: cancelled ? "interrupted" : "failed",
      taskProgress: progress,
      taskStage: cancelled ? "Cancelled" : "Failed",
      errorMessage: cancelled
        ? "Processing was cancelled. Start again to retry."
        : describeError(error),
    });
    if (!cancelled) screenMessage = describeError(error);
  } finally {
    inferenceWorker?.terminate();
    inferenceWorker = undefined;
    rejectInference = undefined;
    working = false;
    await render();
  }
}

function cancelSeparation(): void {
  if (!working) return;
  abortSeparation = true;
  inferenceWorker?.terminate();
  inferenceWorker = undefined;
  rejectInference?.(new DOMException("Separation cancelled.", "AbortError"));
}

function updateProgressDisplay(): void {
  const bar = document.querySelector<HTMLElement>(".progress-track span");
  const stage = document.querySelector<HTMLElement>(
    ".progress-copy span:first-child",
  );
  const value = document.querySelector<HTMLElement>(
    ".progress-copy span:last-child",
  );
  if (bar) bar.style.width = `${progress}%`;
  if (stage) stage.textContent = progressLabel;
  if (value) value.textContent = `${progress}%`;
}

async function downloadFromUrl(project: Project): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#media-url");
  const url = input?.value.trim();
  if (!url) throw new Error("Enter a media URL.");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Enter a valid http or https URL.");
  }
  if (working) return;
  working = true;
  screenMessage = "Starting browser URL downloader…";
  selectedProject = await updateProjectTask(project.id, {
    status: "processing",
    taskProgress: 0,
    taskStage: "Starting browser URL downloader",
    errorMessage: null,
  });
  const id = crypto.randomUUID();
  const worker = new Worker(new URL("./url.worker.ts", import.meta.url), {
    type: "module",
  });
  urlWorker = worker;
  try {
    await render();
    const downloaded = await new Promise<{ name: string; blob: Blob }>(
      (resolve, reject) => {
        rejectUrlDownload = reject;
        worker.onmessage = (event: MessageEvent<UrlMessage>) => {
          const message = event.data;
          if (message.id !== id) return;
          if (message.type === "progress") {
            screenMessage = `${message.stage} · ${message.progress}%`;
            void updateProjectTask(project.id, {
              status: "processing",
              taskProgress: message.progress,
              taskStage: message.stage,
            }).catch((error: unknown) => {
              screenMessage = `Could not save download progress: ${
                describeError(error)
              }`;
              const element = document.querySelector<HTMLElement>(
                ".message span",
              );
              if (element) element.textContent = screenMessage;
              else void render();
            });
            const element = document.querySelector<HTMLElement>(
              ".message span",
            );
            if (element) element.textContent = screenMessage;
          } else if (message.type === "downloaded") {
            resolve({ name: message.name, blob: message.blob });
          } else if (message.type === "updated") {
            reject(new Error("Unexpected update response during download."));
          } else {
            reject(new Error(message.message));
          }
        };
        worker.onerror = (error) =>
          reject(new Error(error.message || "URL download failed."));
        worker.postMessage({ type: "download", id, url });
      },
    );
    selectedProject = await replaceSource(
      project,
      downloaded.blob,
      downloaded.name,
    );
    screenMessage = "";
  } catch (error) {
    const cancelled = error instanceof DOMException &&
      error.name === "AbortError";
    selectedProject = await updateProjectTask(project.id, {
      status: cancelled ? "interrupted" : "failed",
      taskStage: cancelled ? "Download cancelled" : "Download failed",
      errorMessage: cancelled
        ? "Download was cancelled. Retry when ready."
        : describeError(error),
    });
    throw error;
  } finally {
    worker.terminate();
    urlWorker = undefined;
    rejectUrlDownload = undefined;
    working = false;
    await render();
  }
}

async function checkYtDlpUpdate(): Promise<void> {
  if (working) return;
  working = true;
  screenMessage = "Checking yt-dlp…";
  await render();
  const worker = new Worker(new URL("./url.worker.ts", import.meta.url), {
    type: "module",
  });
  urlWorker = worker;
  const id = crypto.randomUUID();
  try {
    const version = await new Promise<string>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<UrlMessage>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          screenMessage = `${message.stage} · ${message.progress}%`;
          const element = document.querySelector<HTMLElement>(".message span");
          if (element) element.textContent = screenMessage;
        } else if (message.type === "updated") {
          resolve(message.version);
        } else if (message.type === "error") {
          reject(new Error(message.message));
        }
      };
      worker.onerror = (error) =>
        reject(new Error(error.message || "yt-dlp update failed."));
      worker.postMessage({
        type: "update",
        id,
        installedVersion: localStorage.getItem("osplit-web-ytdlp-version"),
      });
    });
    localStorage.setItem("osplit-web-ytdlp-version", version);
    screenMessage = `yt-dlp ${version} is ready for browser URL downloads.`;
  } finally {
    worker.terminate();
    urlWorker = undefined;
    working = false;
    await render();
  }
}

async function playAll(): Promise<void> {
  if (!players.size) {
    throw new Error("Separate stems before using the project player.");
  }
  const active = [...players.values()].filter((player) => player.volume > 0);
  if (!active.length) {
    throw new Error("Unmute at least one stem before playing.");
  }
  const reference = players.values().next().value as HTMLAudioElement;
  if (reference.currentTime >= reference.duration) {
    players.forEach((player) => {
      player.currentTime = 0;
    });
  }
  await Promise.all([...players.values()].map((player) => player.play()));
}

async function toggleMute(project: Project, stem: Stem): Promise<void> {
  const muted = project.mutedStems.includes(stem);
  const nextMuted = muted
    ? project.mutedStems.filter((item) => item !== stem)
    : [...project.mutedStems, stem];
  const player = players.get(stem);
  if (player) player.volume = muted ? project.volumes[stem] : 0;
  selectedProject = await saveProject({ ...project, mutedStems: nextMuted });
  await render();
}

async function changeVolume(
  project: Project,
  stem: Stem,
  value: number,
): Promise<void> {
  const safeValue = Math.max(0, Math.min(1, value));
  const updated = {
    ...project,
    volumes: { ...project.volumes, [stem]: safeValue },
  };
  const player = players.get(stem);
  if (player) player.volume = updated.mutedStems.includes(stem) ? 0 : safeValue;
  selectedProject = await saveProject(updated);
}

function seekAll(seconds: number): void {
  players.forEach((player) => {
    if (Number.isFinite(player.duration)) {
      player.currentTime = Math.min(seconds, player.duration);
    }
  });
  updatePlayerDisplay();
}

async function exportStem(project: Project, stem: Stem): Promise<void> {
  const stored = await getStem(project.id, stem);
  if (!stored) throw new Error(`The ${STEM_LABELS[stem]} stem is missing.`);
  downloadBlob(stored.blob, `${safeFileName(project.name)}-${stem}.wav`);
}

async function exportMix(project: Project): Promise<void> {
  const active = STEMS.filter((stem) =>
    project.completedStems.includes(stem) &&
    !project.mutedStems.includes(stem) &&
    project.volumes[stem] > 0
  );
  const records = await Promise.all(
    active.map((stem) => getStem(project.id, stem)),
  );
  if (records.some((record) => !record)) {
    throw new Error("One or more project stem files are missing.");
  }
  const blob = await mixWavBlobs(
    records.map((record) => record!.blob),
    active.map((stem) => project.volumes[stem]),
  );
  downloadBlob(blob, `${safeFileName(project.name)}-mix.wav`);
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function handleInput(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  if (target.id === "seek-bar") seekAll(Number(target.value));
  if (
    target.dataset.action === "volume" && selectedProject && target.dataset.stem
  ) {
    await changeVolume(
      selectedProject,
      target.dataset.stem as Stem,
      Number(target.value),
    );
  }
}

function handleChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  if (target.type === "range" && target.id === "seek-bar") {
    seekAll(Number(target.value));
  }
  if (target.dataset.action === "volume") void render();
}

function describeError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : "Something went wrong.";
  if (isQuotaError(error)) {
    return "Browser storage is full. Delete projects or cached data, then try again.";
  }
  return message;
}

function showFatal(error: unknown): void {
  root!.innerHTML = `
    <main class="fatal">
      <img src="/icon.svg" alt="" />
      <h1>OSplit could not open local storage</h1>
      <p>${escapeHtml(describeError(error))}</p>
      <p class="muted">Use a current browser with IndexedDB enabled and available storage.</p>
    </main>
  `;
}

function statusLabel(status: ProjectStatus): string {
  return {
    empty: "Empty project",
    ready: "Ready",
    processing: "Processing",
    interrupted: "Interrupted",
    failed: "Failed",
  }[status];
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`
    : `${m}:${s}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 100) || "osplit";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]!);
}

root.addEventListener("click", (event) => {
  void handleClick(event).catch((error: unknown) => {
    screenMessage = describeError(error);
    void render();
  });
});
root.addEventListener("input", (event) => {
  void handleInput(event).catch((error: unknown) => {
    screenMessage = describeError(error);
    void render();
  });
});
root.addEventListener("change", handleChange);
root.addEventListener("change", (event) => {
  if ((event.target as HTMLElement).id === "audio-file") {
    void handleFileChange(event);
  }
});

window.addEventListener("pagehide", () => {
  inferenceWorker?.terminate();
  urlWorker?.terminate();
  releasePlayers();
});
