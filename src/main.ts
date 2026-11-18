import "./style.css";
import {
  exportAll,
  exportMix,
  exportStem,
  setExportAppliesPractice,
  setExportFormat,
} from "./export";
import { enableIsolationReload } from "./isolation";
import { appUrl } from "./paths";
import {
  applyPractice,
  applyStemVolume,
  isPlaying,
  pauseAll,
  playAll,
  playerTime,
  preparePlayers,
  releasePlayers,
  seekAll,
  setPlayerLoaded,
  setPlayerTick,
} from "./player";
import { soloStems, toggleStem } from "./mixing";
import {
  clampSemitones,
  clampSpeed,
  loopWithEnd,
  loopWithStart,
  nudgeLoopEdge,
  projectSemitones,
  projectSpeed,
  SPEED_STEP,
} from "./practice";
import { startMediaSession, updateMediaSession } from "./player/media-session";
import { onRender, state } from "./state";
import {
  deleteProject,
  getProject,
  listProjects,
  replaceSource,
  requestPersistentStorage,
  saveProject,
} from "./storage";
import { heldTaskLocks, taskLockName, withTaskLock } from "./task-lock";
import {
  cancelSeparation,
  separateProject,
  terminateInferenceWorker,
} from "./tasks/separation";
import {
  cancelUrlDownload,
  checkYtDlpUpdate,
  downloadFromUrl,
  terminateUrlWorker,
  urlTaskActive,
} from "./tasks/url-download";
import {
  importAsNewProject,
  installLaunchQueue,
  isAudioFile,
  NOT_AUDIO_MESSAGE,
  takeSharedFile,
} from "./tasks/import";
import { installWakeLock } from "./tasks/wake-lock";
import { newProject, type Project, type Quality, type Stem } from "./types";
import { renderDetail } from "./view/detail";
import { confirmDialog } from "./view/dialog";
import { captureForm, restoreForm } from "./view/form-state";
import { describeError, escapeHtml } from "./view/format";
import { installLoopDrag, takeSuppressedClick } from "./view/loop-drag";
import { updatePlayerDisplay } from "./view/mixer";
import { updateLoopDisplay, updatePracticeDisplay } from "./view/practice";
import { renderProjects } from "./view/projects";
import { showWaveforms, waveformSeekTime } from "./view/waveforms";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("The app root element is missing.");

onRender(render);
setPlayerTick(() => {
  updatePlayerDisplay();
  updateMediaSession(playerTime());
});
setPlayerLoaded((project) => {
  void showWaveforms(project).catch(console.warn);
  updateLoopDisplay(state.selectedProject);
  startMediaSession(project.name, {
    play: () => void togglePlay(true).catch(showError),
    pause: () => void togglePlay(false).catch(showError),
    seek: seekTo,
    time: () => playerTime(),
  });
});
installWakeLock();
void start();

async function start(): Promise<void> {
  registerServiceWorker();
  try {
    state.projects = await listProjects();
    // A task still running in another tab holds its project's lock.
    const held = await heldTaskLocks();
    for (const project of state.projects) {
      if (
        project.status === "processing" &&
        !held?.has(taskLockName(project.id))
      ) {
        await saveProject({
          ...project,
          status: "interrupted",
          errorMessage:
            "The browser stopped the previous task. Start separation again to retry.",
        });
      }
    }
    state.projects = await listProjects();
    const lastId = localStorage.getItem("osplit-web-last-project");
    state.selectedProject =
      state.projects.find((project) => project.id === lastId) ?? null;
    await render();
    void requestPersistentStorage();
    installLaunchQueue((file) => void importFile(file));
    const shared = await takeSharedFile();
    if (shared) await importFile(shared);
  } catch (error) {
    showFatal(error);
  }
}

/** Imports a file shared, opened with or dropped on the app. */
async function importFile(file: File): Promise<void> {
  try {
    if (state.working) {
      throw new Error(
        "Wait for the current task or cancel it before importing another file.",
      );
    }
    if (state.selectedProject && renderedView?.startsWith("project:")) {
      if (!isAudioFile(file)) throw new Error(NOT_AUDIO_MESSAGE);
      await importSource(file);
    } else {
      await importAsNewProject(file);
    }
  } catch (error) {
    showError(error);
  }
}

function registerServiceWorker(): void {
  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" || location.hostname === "localhost")
  ) {
    void navigator.serviceWorker.register(appUrl("sw.js")).catch((error: unknown) => {
      console.warn("Offline app shell could not be registered.", error);
    });
    enableIsolationReload(() => state.working);
  }
}

let renderedView: string | null = null;

async function render(): Promise<void> {
  const snapshot = captureForm(root!, renderedView);
  state.projects = await listProjects();
  if (state.selectedProject) {
    state.selectedProject = state.projects.find((project) =>
      project.id === state.selectedProject?.id
    ) ?? null;
  }
  if (state.selectedProject) {
    root!.innerHTML = renderDetail(state.selectedProject);
    renderedView = `project:${state.selectedProject.id}`;
    restoreForm(snapshot, renderedView);
    // Loading the player (decoding the stems) runs in the background; the
    // play button shows the loading state until it is ready.
    void preparePlayers(state.selectedProject).catch(showError);
    void showWaveforms(state.selectedProject).catch(console.warn);
    updateLoopDisplay(state.selectedProject);
  } else {
    releasePlayers();
    root!.innerHTML = await renderProjects();
    renderedView = "projects";
    restoreForm(snapshot, renderedView);
  }
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
        state.selectedProject = await saveProject(newProject(name));
        localStorage.setItem("osplit-web-last-project", state.selectedProject.id);
        state.screenMessage = "";
        await render();
        break;
      }
      case "open":
        state.selectedProject = (await getProject(id ?? "")) ?? null;
        if (!state.selectedProject) {
          throw new Error("That project no longer exists.");
        }
        localStorage.setItem("osplit-web-last-project", state.selectedProject.id);
        await render();
        break;
      case "home":
        if (state.working) {
          throw new Error(
            "Wait for the current task or cancel it before leaving this project.",
          );
        }
        state.selectedProject = null;
        localStorage.removeItem("osplit-web-last-project");
        state.screenMessage = "";
        await render();
        break;
      case "delete":
        if (
          id &&
          await confirmDialog(
            "Delete this project and all its source audio and stems?",
            "Delete project",
          )
        ) {
          await deleteProject(id);
          if (state.selectedProject?.id === id) state.selectedProject = null;
          await render();
        }
        break;
      case "import":
        state.fileDialogTarget = "source";
        document.querySelector<HTMLInputElement>("#audio-file")?.click();
        break;
      case "quality":
        if (state.selectedProject && button.dataset.quality) {
          state.selectedProject = await saveProject({
            ...state.selectedProject,
            quality: button.dataset.quality as Quality,
          });
          await render();
        }
        break;
      case "separate":
        if (state.selectedProject) {
          const project = state.selectedProject;
          void withTaskLock(project.id, () => separateProject(project))
            .catch(showError);
        }
        break;
      case "cancel":
        if (urlTaskActive()) cancelUrlDownload();
        else cancelSeparation();
        break;
      case "download-url":
        if (state.selectedProject) {
          const project = state.selectedProject;
          await withTaskLock(project.id, () => downloadFromUrl(project));
        }
        break;
      case "yt-update":
        await checkYtDlpUpdate();
        break;
      case "dismiss":
        state.screenMessage = "";
        await render();
        break;
      case "play":
        await togglePlay(!isPlaying());
        break;
      case "mute":
        if (state.selectedProject && button.dataset.stem) {
          await toggleMute(state.selectedProject, button.dataset.stem as Stem);
        }
        break;
      case "solo":
        if (state.selectedProject && button.dataset.stem) {
          await toggleSolo(state.selectedProject, button.dataset.stem as Stem);
        }
        break;
      case "export-stem":
        if (state.selectedProject && button.dataset.stem) {
          await exportStem(state.selectedProject, button.dataset.stem as Stem);
        }
        break;
      case "export-mix":
        if (state.selectedProject) await exportMix(state.selectedProject);
        break;
      case "waveform-seek":
        // The end of a loop drag, or a press on a loop handle, doesn't seek.
        if (takeSuppressedClick()) break;
        if ((event.target as HTMLElement).closest("[data-loop-handle]")) break;
        seekTo(waveformSeekTime(button, (event as MouseEvent).clientX));
        break;
      case "speed-step":
        if (state.selectedProject) {
          await stepSpeed(state.selectedProject, Number(button.dataset.step));
        }
        break;
      case "key-step":
        if (state.selectedProject) {
          await stepKey(state.selectedProject, Number(button.dataset.step));
        }
        break;
      case "practice-reset":
        if (state.selectedProject) {
          await savePractice({
            ...state.selectedProject,
            speed: 1,
            semitones: 0,
            loop: undefined,
          });
        }
        break;
      case "loop-set":
        if (state.selectedProject) {
          await setLoopEdge(
            state.selectedProject,
            button.dataset.edge === "start" ? "start" : "end",
          );
        }
        break;
      case "loop-toggle":
        if (state.selectedProject) await toggleLoop(state.selectedProject);
        break;
      case "loop-clear":
        if (state.selectedProject) {
          await savePractice({ ...state.selectedProject, loop: undefined });
        }
        break;
      case "export-all":
        if (state.selectedProject) await exportAll(state.selectedProject);
        break;
    }
  } catch (error) {
    state.screenMessage = describeError(error);
    await render();
  }
}

/** Plays (`play` true) or pauses the project player. */
async function togglePlay(play: boolean): Promise<void> {
  if (!play) await pauseAll();
  else if (state.selectedProject) await playAll(state.selectedProject);
  updatePlayerDisplay();
  updateMediaSession(playerTime());
}

function seekTo(seconds: number): void {
  const { duration } = playerTime();
  seekAll(Math.max(0, Math.min(duration, seconds)));
  updateMediaSession(playerTime(), true);
}

const SEEK_STEP_SECONDS = 5;
/** How far the arrow keys move a focused loop handle (Shift: 1 s). */
const LOOP_NUDGE_SECONDS = 0.1;

/**
 * Applies changed speed, key or loop to the player and the practice bar, and
 * saves them unless `save` is false (a slider still being dragged).
 */
async function savePractice(updated: Project, save = true): Promise<void> {
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

function stepSpeed(project: Project, steps: number): Promise<void> {
  return savePractice({
    ...project,
    speed: clampSpeed(projectSpeed(project) + steps * SPEED_STEP),
  });
}

function stepKey(project: Project, steps: number): Promise<void> {
  return savePractice({
    ...project,
    semitones: clampSemitones(projectSemitones(project) + steps),
  });
}

/** Sets the loop start (A) or end (B) at the playhead. */
function setLoopEdge(project: Project, edge: "start" | "end"): Promise<void> {
  const { position, duration } = playerTime();
  if (!duration) return Promise.resolve();
  const loop = edge === "start"
    ? loopWithStart(project.loop, position, duration)
    : loopWithEnd(project.loop, position, duration);
  return savePractice({ ...project, loop });
}

function toggleLoop(project: Project): Promise<void> {
  if (!project.loop) return Promise.resolve();
  return savePractice({
    ...project,
    loop: { ...project.loop, enabled: !project.loop.enabled },
  });
}

/**
 * Project-page shortcuts: Space plays or pauses, ←/→ seek 5 s, Home returns
 * to the start, and M/S mute or solo the focused stem row. Practice: [ and ]
 * set the loop start and end, L toggles the loop (Shift+L clears it), − and
 * = change the speed, comma and period the key, and 0 resets speed and key.
 * On a focused loop handle, ←/→ move it. Keys typed into a form field, or
 * used on a focused button or menu, keep their usual meaning.
 */
async function handleKeyDown(event: KeyboardEvent): Promise<void> {
  const project = state.selectedProject;
  if (!project?.completedStems.length) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target.closest("input, select, textarea, [contenteditable]")) return;
  if (!playerTime().ready) return;
  const row = target.closest<HTMLElement>("[data-stem-row]");
  const onButton = target.closest("button") !== null;
  const handle = target.closest<HTMLElement>("[data-loop-handle]");
  if (
    handle && project.loop &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    const step = (event.shiftKey ? 1 : LOOP_NUDGE_SECONDS) *
      (event.key === "ArrowLeft" ? -1 : 1);
    const edge = handle.dataset.loopHandle === "start" ? "start" : "end";
    await savePractice({
      ...project,
      loop: nudgeLoopEdge(project.loop, edge, step, playerTime().duration),
    });
    return;
  }
  switch (event.key) {
    case " ":
      if (onButton) return;
      event.preventDefault();
      await togglePlay(!isPlaying());
      break;
    case "ArrowLeft":
    case "ArrowRight":
      event.preventDefault();
      seekTo(
        playerTime().position +
          (event.key === "ArrowLeft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS),
      );
      break;
    case "Home":
      event.preventDefault();
      seekTo(0);
      break;
    case "m":
    case "M":
    case "s":
    case "S": {
      if (!row) return;
      event.preventDefault();
      const stem = row.dataset.stemRow as Stem;
      if (event.key.toLowerCase() === "m") await toggleMute(project, stem);
      else await toggleSolo(project, stem);
      // The re-render replaced the row; keep the focus on it.
      document.querySelector<HTMLElement>(`[data-stem-row="${stem}"]`)
        ?.focus();
      break;
    }
    case "[":
    case "]":
      event.preventDefault();
      await setLoopEdge(project, event.key === "[" ? "start" : "end");
      break;
    case "l":
    case "L":
      event.preventDefault();
      if (event.shiftKey) await savePractice({ ...project, loop: undefined });
      else await toggleLoop(project);
      break;
    case "-":
    case "_":
      event.preventDefault();
      await stepSpeed(project, -1);
      break;
    case "=":
    case "+":
      event.preventDefault();
      await stepSpeed(project, 1);
      break;
    case ",":
    case ".":
      event.preventDefault();
      await stepKey(project, event.key === "," ? -1 : 1);
      break;
    case "0":
      event.preventDefault();
      await savePractice({ ...project, speed: 1, semitones: 0 });
      break;
  }
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || state.fileDialogTarget !== "source" || !state.selectedProject) {
    return;
  }
  state.fileDialogTarget = "none";
  try {
    await importSource(file);
  } catch (error) {
    state.screenMessage = describeError(error);
    await render();
  }
}

/** Makes a file the open project's source audio (clearing its stems). */
async function importSource(file: File): Promise<void> {
  if (!state.selectedProject) return;
  state.selectedProject = await replaceSource(
    state.selectedProject,
    file,
    file.name,
  );
  state.screenMessage = "";
  await render();
}

async function toggleMute(project: Project, stem: Stem): Promise<void> {
  await saveMix({ ...project, mutedStems: toggleStem(project.mutedStems, stem) });
}

async function toggleSolo(project: Project, stem: Stem): Promise<void> {
  await saveMix({ ...project, soloStems: toggleStem(soloStems(project), stem) });
}

/** Applies a changed mute/solo state to every stem, saves it and re-renders. */
async function saveMix(updated: Project): Promise<void> {
  // Set at once, so a quick next key press builds on this change.
  state.selectedProject = updated;
  for (const stem of updated.completedStems) applyStemVolume(updated, stem);
  state.selectedProject = await saveProject(updated);
  await render();
}

/** Applies slider moves immediately; `handleChange` saves when released. */
function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  if (target.id === "seek-bar") seekAll(Number(target.value));
  if (
    target.dataset.action === "volume" && state.selectedProject &&
    target.dataset.stem
  ) {
    const stem = target.dataset.stem as Stem;
    const value = Math.max(0, Math.min(1, Number(target.value) || 0));
    state.selectedProject = {
      ...state.selectedProject,
      volumes: { ...state.selectedProject.volumes, [stem]: value },
    };
    applyStemVolume(state.selectedProject, stem);
  }
  if (target.dataset.action === "speed" && state.selectedProject) {
    void savePractice({
      ...state.selectedProject,
      speed: clampSpeed(Number(target.value) / 100),
    }, false).catch(showError);
  }
}

async function handleChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  if (target.dataset.action === "export-format") {
    setExportFormat(target.value === "wav" ? "wav" : "flac");
    return;
  }
  if (target.dataset.action === "export-practice") {
    setExportAppliesPractice(target.checked);
    return;
  }
  if (target.dataset.action === "delete-source-option" && state.selectedProject) {
    state.selectedProject = await saveProject({
      ...state.selectedProject,
      deleteSourceAfterSeparation: target.checked,
    });
    return;
  }
  if (target.type === "range" && target.id === "seek-bar") {
    seekAll(Number(target.value));
  }
  if (target.dataset.action === "volume" && state.selectedProject) {
    state.selectedProject = await saveProject(state.selectedProject);
  }
  if (target.dataset.action === "speed" && state.selectedProject) {
    await savePractice({
      ...state.selectedProject,
      speed: clampSpeed(Number(target.value) / 100),
    });
  }
}

function showFatal(error: unknown): void {
  root!.innerHTML = `
    <main class="fatal">
      <img src="${appUrl("icon.svg")}" alt="" />
      <h1>OSplit could not open local storage</h1>
      <p>${escapeHtml(describeError(error))}</p>
      <p class="muted">Use a current browser with IndexedDB enabled and available storage.</p>
    </main>
  `;
}

function showError(error: unknown): void {
  state.screenMessage = describeError(error);
  void render();
}

root.addEventListener("click", (event) => {
  void handleClick(event).catch(showError);
});
root.addEventListener("input", handleInput);
installLoopDrag(root, {
  loop: () => state.selectedProject?.loop,
  duration: () => playerTime().duration,
  preview: (loop) => {
    if (!state.selectedProject) return;
    void savePractice({ ...state.selectedProject, loop }, false).catch(showError);
  },
  commit: (loop) => {
    if (!state.selectedProject) return;
    void savePractice({ ...state.selectedProject, loop }).catch(showError);
  },
});
document.addEventListener("keydown", (event) => {
  void handleKeyDown(event).catch(showError);
});
root.addEventListener("change", (event) => {
  void handleChange(event).catch(showError);
});
root.addEventListener("change", (event) => {
  if ((event.target as HTMLElement).id === "audio-file") {
    void handleFileChange(event);
  }
});

// Drag and drop: onto the project list it creates a project, onto a project
// page it replaces that project's source audio.
function draggingFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}
root.addEventListener("dragover", (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
  root.classList.add("drop-target");
});
root.addEventListener("dragleave", (event) => {
  if (!root.contains(event.relatedTarget as Node | null)) {
    root.classList.remove("drop-target");
  }
});
root.addEventListener("drop", (event) => {
  root.classList.remove("drop-target");
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  event.preventDefault();
  void importFile(file);
});

window.addEventListener("pagehide", () => {
  terminateInferenceWorker();
  terminateUrlWorker();
  releasePlayers();
});
