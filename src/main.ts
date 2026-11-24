import "./style.css";
import { downloadBlob } from "./export";
import {
  autoSync,
  connect as connectCloud,
  connection as cloudConnection,
  disconnect as disconnectCloud,
  downloadRemote,
  finishSignIn,
  inCloud,
  removeRemote,
  setAutoSync,
  syncNow,
} from "./cloud/cloud";
import { detectGpu } from "./gpu";
import { enableIsolationReload } from "./isolation";
import { appUrl } from "./paths";
import {
  playerTime,
  preparePlayers,
  releasePlayers,
  setPlayerLoaded,
  setPlayerTick,
} from "./player";
import { startMediaSession } from "./player/media-session";
import {
  asCopy,
  createProjectFile,
  isProjectFile,
  projectFileName,
  readProjectFile,
} from "./project-file";
import { onRender, requestRender, showMessage, state } from "./state";
import {
  deleteProject,
  getProject,
  listProjects,
  patchProject,
  readProjectData,
  replaceSource,
  requestPersistentStorage,
  saveProject,
  storageEstimate,
  writeProjectData,
} from "./storage";
import { heldTaskLocks, taskLockName, withTaskLock } from "./task-lock";
import { forgetAnalysis, loadAnalysis, onAnalysisChange } from "./tasks/analysis";
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
import { type ModelId, newProject, type Project } from "./types";
import { renderDetail, setSetupOpen } from "./view/detail";
import { choiceDialog, confirmDialog, textDialog } from "./view/dialog";
import { type MenuItem, openMenu } from "./view/menu";
import { setPanel } from "./view/panels";
import { captureForm, restoreForm } from "./view/form-state";
import { describeError, escapeHtml, formatBytes } from "./view/format";
import { applyLibraryFilter, library, renderProjects } from "./view/projects";
import { newSplitOpen, openNewSplit } from "./view/new-split";
import { forgetOpened, LIBRARY_FILTERS, markOpened } from "./library";
import { renderSettings } from "./view/settings";
import { shellMarkup } from "./view/shell";
import {
  handlePracticeChange,
  handlePracticeClick,
  handlePracticeInput,
  handlePracticeKey,
  installPracticeListeners,
  onPracticeRendered,
  practiceTick,
  refreshAnalysis,
  resetPracticeState,
  seekTo,
  togglePlay,
} from "./practice-controller";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("The app root element is missing.");

onRender(render);
setPlayerTick(practiceTick);
setPlayerLoaded((project) => {
  if (state.selectedProject) {
    refreshAnalysis(state.selectedProject);
    onPracticeRendered(state.selectedProject);
  }
  startMediaSession(project.name, {
    play: () => void togglePlay(true).catch(showError),
    pause: () => void togglePlay(false).catch(showError),
    seek: seekTo,
    time: () => playerTime(),
  });
});
onAnalysisChange((projectId) => {
  if (state.selectedProject?.id === projectId && renderedView?.startsWith("project:")) {
    refreshAnalysis(state.selectedProject);
  }
});
installWakeLock();
void start();

async function start(): Promise<void> {
  registerServiceWorker();
  // The model picker and new projects' default model depend on WebGPU.
  // Detection is usually instant; do not hold the page for a slow one.
  let gpuDetected = false;
  const gpu = detectGpu().then(() => {
    gpuDetected = true;
  });
  await Promise.race([gpu, new Promise((resolve) => setTimeout(resolve, 1500))]);
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
    // Back from a cloud storage sign-in page: show the project list.
    const signedIn = await finishSignIn().catch((error: unknown) => describeError(error));
    if (signedIn) {
      state.selectedProject = null;
      state.screenMessage = signedIn;
    }
    await render();
    // A slow detection re-renders once it is known. Only after the first
    // render: a render started earlier, before the last project is selected,
    // could finish last and replace the project page with the project list.
    if (!gpuDetected) void gpu.then(() => requestRender());
    void requestPersistentStorage();
    if (cloudConnection() && (signedIn || autoSync())) void runCloudSync(false);
    installLaunchQueue((file) => void importFile(file));
    const shared = await takeSharedFile();
    if (shared) await importFile(shared);
  } catch (error) {
    showFatal(error);
  }
}

/** Imports a file shared, opened with or dropped on the app. */
async function importFile(file: File, dropped = false): Promise<void> {
  try {
    if (state.working) {
      throw new Error(
        "Wait for the current task or cancel it before importing another file.",
      );
    }
    if (isProjectFile(file)) {
      await importProjectFile(file);
    } else if (state.selectedProject && renderedView?.startsWith("project:")) {
      if (!isAudioFile(file)) throw new Error(NOT_AUDIO_MESSAGE);
      await importSource(file);
    } else {
      if (dropped) {
        // Dropped on the library: start a New split with the file.
        if (!isAudioFile(file)) throw new Error(NOT_AUDIO_MESSAGE);
        await newSplit(file);
      } else {
        await importAsNewProject(file);
        if (state.selectedProject) markOpened(state.selectedProject.id);
      }
    }
  } catch (error) {
    showError(error);
  }
}

/** Saves a project as a .osplit file, to open on another device. */
async function exportProjectFile(id: string): Promise<void> {
  const data = await readProjectData(id);
  if (!data) throw new Error("That project no longer exists.");
  showMessage("Preparing the project file…");
  const file = await createProjectFile(data);
  downloadBlob(file, projectFileName(data.project));
  showMessage(
    `Exported "${data.project.name}" (${formatBytes(file.size)}). Open the file with OSplit on another device to import it.`,
  );
}

/** Adds the project in a .osplit file, or replaces the copy already here. */
async function importProjectFile(file: File): Promise<void> {
  if (state.working) {
    throw new Error("Wait for the current task or cancel it before importing a project.");
  }
  showMessage("Reading the project file…");
  let data = await readProjectFile(file);
  const estimate = await storageEstimate();
  if (
    estimate?.quota && estimate.usage !== undefined &&
    file.size > estimate.quota - estimate.usage
  ) {
    throw new Error(
      `Not enough browser storage to import this project (${formatBytes(file.size)}). Delete projects, then try again.`,
    );
  }
  const existing = await getProject(data.project.id);
  if (existing) {
    const choice = await choiceDialog(
      `"${existing.name}" is already on this device. Replace it with the imported version, or keep both?`,
      [{ value: "copy", label: "Keep both" }, { value: "replace", label: "Replace" }],
    );
    if (!choice) {
      state.screenMessage = "";
      await render();
      return;
    }
    if (choice === "copy") {
      data = asCopy(data);
    } else if (existing.status === "processing") {
      throw new Error(
        "That project is being processed. Wait for it to finish or cancel it, then import again.",
      );
    }
  }
  // The open project's stems are about to change under the player.
  if (state.selectedProject?.id === data.project.id) releasePlayers();
  const project = await writeProjectData(data);
  forgetAnalysis(project.id);
  state.selectedProject = project;
  localStorage.setItem("osplit-web-last-project", project.id);
  state.screenMessage = `Imported "${project.name}".`;
  await render();
}

/** Ids replaced by the running cloud sync, to know what to re-render. */
const cloudReplaced = new Set<string>();
const cloudHooks = {
  replacing(projectId: string) {
    // The open project's stems are about to change under the player.
    if (state.selectedProject?.id === projectId) releasePlayers();
    forgetAnalysis(projectId);
    cloudReplaced.add(projectId);
  },
};

/**
 * Syncs with the connected cloud storage. A sync the user asked for shows
 * its outcome as the page message; an automatic one only in the cloud panel.
 */
async function runCloudSync(manual: boolean): Promise<void> {
  cloudReplaced.clear();
  const rerender = () =>
    renderedView === "projects" ||
    (state.selectedProject !== null && cloudReplaced.has(state.selectedProject.id));
  try {
    // The sync marks itself busy at once: show that.
    const sync = syncNow(cloudHooks);
    if (renderedView === "projects") await render();
    const summary = await sync;
    if (manual) state.screenMessage = summary;
  } catch (error) {
    if (manual) throw error;
    console.warn("Automatic cloud sync failed.", error);
  } finally {
    if (rerender()) await render();
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
    root!.innerHTML = shellMarkup("project", renderDetail(state.selectedProject));
    renderedView = `project:${state.selectedProject.id}`;
    restoreForm(snapshot, renderedView);
    // Loading the player (decoding the stems) runs in the background; the
    // play button shows the loading state until it is ready.
    void preparePlayers(state.selectedProject).catch(showError);
    const project = state.selectedProject;
    if (project.completedStems.length) {
      onPracticeRendered(project);
      void loadAnalysis(project)
        .then(() => {
          if (state.selectedProject?.id === project.id) {
            refreshAnalysis(state.selectedProject);
          }
        })
        .catch(console.warn);
    }
  } else if (state.page === "settings") {
    releasePlayers();
    root!.innerHTML = shellMarkup("settings", await renderSettings());
    renderedView = "settings";
    restoreForm(snapshot, renderedView);
  } else {
    releasePlayers();
    root!.innerHTML = shellMarkup("library", await renderProjects());
    renderedView = "projects";
    restoreForm(snapshot, renderedView);
    applyLibraryFilter();
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
    if (action && await handlePracticeClick(action, button, event)) return;
    switch (action) {
      case "open":
        await openProject(id ?? "");
        break;
      case "resume": {
        const project = await openProject(id ?? "");
        void withTaskLock(project.id, () => separateProject(project)).catch(showError);
        break;
      }
      case "library-filter": {
        const filter = LIBRARY_FILTERS.find((item) => item.id === button.dataset.filter);
        if (filter) library.filter = filter.id;
        applyLibraryFilter();
        break;
      }
      case "home":
      case "settings":
      case "new-split":
        // A split keeps running in the background; a link download needs
        // its page.
        if (urlTaskActive()) {
          throw new Error(
            "Wait for the download or cancel it before leaving this project.",
          );
        }
        await leaveProject(action === "settings" ? "settings" : "library");
        if (action === "new-split") await newSplit();
        break;
      case "delete":
        if (id) await deleteWithConfirmation(id);
        break;
      case "export-project": {
        const projectId = id ?? state.selectedProject?.id;
        if (projectId) await exportProjectFile(projectId);
        break;
      }
      case "cloud-connect": {
        const provider = button.dataset.provider;
        if (provider !== "dropbox" && provider !== "onedrive") break;
        if (state.working) {
          throw new Error("Wait for the current task or cancel it: signing in leaves this page for a moment.");
        }
        await connectCloud(provider);
        break;
      }
      case "cloud-sync":
        await runCloudSync(true);
        break;
      case "cloud-disconnect": {
        const cloud = cloudConnection();
        if (
          cloud &&
          await confirmDialog(
            `Disconnect ${cloud.label}? Projects stay on this device and in ${cloud.label}.`,
            "Disconnect",
          )
        ) {
          await disconnectCloud();
          state.screenMessage = `Disconnected from ${cloud.label}.`;
          await render();
        }
        break;
      }
      case "cloud-download":
        if (id) {
          try {
            const download = downloadRemote(id, cloudHooks);
            await render();
            const name = await download;
            state.screenMessage = `Downloaded "${name}".`;
          } finally {
            await render();
          }
        }
        break;
      case "cloud-remove": {
        const cloud = cloudConnection();
        if (
          id && cloud &&
          await confirmDialog(
            `Remove this project from ${cloud.label}? It isn't on this device, so it will be gone.`,
            "Remove",
          )
        ) {
          await removeRemote(id);
          await render();
        }
        break;
      }
      case "import-project":
        document.querySelector<HTMLInputElement>("#project-file")?.click();
        break;
      case "import":
        state.fileDialogTarget = "source";
        document.querySelector<HTMLInputElement>("#audio-file")?.click();
        break;
      case "model":
        if (state.selectedProject && button.dataset.model) {
          state.selectedProject = await saveProject({
            ...state.selectedProject,
            model: button.dataset.model as ModelId,
          });
          await render();
        }
        break;
      case "separate":
        setSetupOpen(false);
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
          const url = document.querySelector<HTMLInputElement>("#media-url")?.value ?? "";
          await withTaskLock(project.id, () => downloadFromUrl(project, url));
        }
        break;
      case "yt-update":
        await checkYtDlpUpdate();
        break;
      case "dismiss":
        state.screenMessage = "";
        await render();
        break;
      case "project-menu": {
        const projectId = id ?? state.selectedProject?.id;
        if (projectId) await projectMenu(projectId, button);
        break;
      }
      case "split-cancel":
        setSetupOpen(false);
        await render();
        break;

    }
  } catch (error) {
    state.screenMessage = describeError(error);
    await render();
  }
}

/** Opens a project's page. */
async function openProject(id: string): Promise<Project> {
  const project = await getProject(id);
  if (!project) throw new Error("That project no longer exists.");
  if (state.selectedProject?.id !== project.id) {
    resetPracticeState();
    setSetupOpen(false);
  }
  state.page = "library";
  state.selectedProject = project;
  state.screenMessage = "";
  markOpened(project.id);
  localStorage.setItem("osplit-web-last-project", project.id);
  await render();
  return project;
}

/**
 * The New split dialog: makes a project from a file or a link, opens it and
 * separates it (a link is downloaded first).
 */
async function newSplit(file?: File): Promise<void> {
  if (state.working) {
    throw new Error("Wait for the current task or cancel it before starting another split.");
  }
  if (newSplitOpen()) return;
  const request = await openNewSplit(file);
  if (!request) return;
  let project = await saveProject(newProject(request.name, request.model));
  if ("file" in request.source) {
    project = await replaceSource(project, request.source.file, request.source.file.name);
  }
  await openProject(project.id);
  if ("url" in request.source) {
    const url = request.source.url;
    await withTaskLock(project.id, () => downloadFromUrl(project, url));
    const downloaded = await getProject(project.id);
    // A failed or cancelled download leaves the project without audio.
    if (!downloaded?.sourceName || downloaded.status !== "ready") return;
    project = downloaded;
  } else {
    project = (await getProject(project.id)) ?? project;
  }
  void withTaskLock(project.id, () => separateProject(project)).catch(showError);
}

/** Closes the open project, if any, and shows the library or settings. */
async function leaveProject(page: "library" | "settings"): Promise<void> {
  const wasOpen = state.selectedProject !== null;
  resetPracticeState();
  setSetupOpen(false);
  state.selectedProject = null;
  state.page = page;
  localStorage.removeItem("osplit-web-last-project");
  state.screenMessage = "";
  await render();
  // Changes made in the project go up when leaving it.
  if (wasOpen && cloudConnection() && autoSync()) void runCloudSync(false);
}

/** Deletes a project after asking (and, if it is in the cloud, where). */
async function deleteWithConfirmation(id: string): Promise<void> {
  if ((state.working && state.taskProjectId === id) || (await getProject(id))?.status === "processing") {
    throw new Error("This project is being split. Cancel the split first, then delete it.");
  }
  const cloud = cloudConnection();
  let confirmed: boolean;
  let alsoCloud = false;
  if (cloud && inCloud(id)) {
    const choice = await choiceDialog(
      `Delete this project and all its source audio and stems? Its copy in ${cloud.label} can stay, to download again later.`,
      [
        { value: "local", label: "Delete from this device" },
        { value: "everywhere", label: `Also delete from ${cloud.label}` },
      ],
    );
    confirmed = choice !== null;
    alsoCloud = choice === "everywhere";
  } else {
    confirmed = await confirmDialog(
      "Delete this project and all its source audio and stems?",
      "Delete project",
    );
  }
  if (confirmed) {
    if (alsoCloud) await removeRemote(id);
    await deleteProject(id);
    forgetAnalysis(id);
    forgetOpened(id);
    if (state.selectedProject?.id === id) state.selectedProject = null;
    await render();
  }
}

/**
 * A project's menu (⋯), on its page or in the library: open, rename, save
 * as a project file, export, split again, delete.
 */
async function projectMenu(id: string, anchor: HTMLElement): Promise<void> {
  const project = await getProject(id);
  if (!project) throw new Error("That project no longer exists.");
  const onPage = state.selectedProject?.id === id;
  const ready = project.completedStems.length > 0 && project.status !== "processing";
  const items: MenuItem[] = [];
  if (!onPage) items.push({ value: "open", label: "Open" });
  items.push({ value: "rename", label: "Rename" });
  if (project.status !== "processing") {
    items.push({ value: "file", label: "Save as project file", sub: "One .osplit file, to move it to another device" });
  }
  if (onPage && ready) items.push({ value: "export", label: "Export…", sub: "Stems, mix or chords" });
  if (onPage && ready) items.push({ value: "split", label: "Split again…", sub: "Another model, or new audio" });
  items.push({ value: "delete", label: "Delete", danger: true });
  const choice = await openMenu(anchor, project.name, items);
  switch (choice) {
    case "open":
      await openProject(id);
      break;
    case "rename": {
      const name = await textDialog("Rename project", "Name", project.name, 80);
      if (!name) break;
      const latest = await getProject(id);
      if (!latest) break;
      const renamed = await saveProject({ ...latest, name });
      if (state.selectedProject?.id === id) state.selectedProject = renamed;
      await render();
      break;
    }
    case "file":
      await exportProjectFile(id);
      break;
    case "export":
      setPanel("export");
      break;
    case "split":
      setSetupOpen(true);
      await render();
      break;
    case "delete":
      await deleteWithConfirmation(id);
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
  forgetAnalysis(state.selectedProject.id);
  state.screenMessage = "";
  await render();
}

/** Applies slider moves and typing immediately; `handleChange` saves when released. */
function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  if (target.id === "library-search") {
    library.query = target.value;
    applyLibraryFilter();
    return;
  }
  handlePracticeInput(event);
}

async function handleChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  if (target.dataset.action === "delete-source-option" && state.selectedProject) {
    // A split may be writing its progress meanwhile: change only this field.
    state.selectedProject = await patchProject(state.selectedProject.id, {
      deleteSourceAfterSeparation: target.checked,
    });
    return;
  }
  await handlePracticeChange(event);
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
installPracticeListeners(root);
document.addEventListener("keydown", (event) => {
  void handlePracticeKey(event).catch(showError);
});
root.addEventListener("change", (event) => {
  void handleChange(event).catch(showError);
});
root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "audio-file") void handleFileChange(event);
  if (input.id === "cloud-auto") setAutoSync(input.checked);
  if (input.id === "project-file") {
    const file = input.files?.[0];
    input.value = "";
    if (file) void importProjectFile(file).catch(showError);
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
  void importFile(file, true);
});

window.addEventListener("pagehide", () => {
  terminateInferenceWorker();
  terminateUrlWorker();
  releasePlayers();
});
