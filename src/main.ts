import "./style.css";
import { exportMix, exportStem } from "./export";
import { enableIsolationReload } from "./isolation";
import { appUrl } from "./paths";
import {
  applyStemVolume,
  isPlaying,
  pauseAll,
  playAll,
  preparePlayers,
  releasePlayers,
  seekAll,
  setPlayerTick,
} from "./player";
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
import { installWakeLock } from "./tasks/wake-lock";
import { newProject, type Project, type Quality, type Stem } from "./types";
import { renderDetail } from "./view/detail";
import { captureForm, restoreForm } from "./view/form-state";
import { describeError, escapeHtml } from "./view/format";
import { updatePlayerDisplay } from "./view/mixer";
import { renderProjects } from "./view/projects";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("The app root element is missing.");

onRender(render);
setPlayerTick(updatePlayerDisplay);
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
  } catch (error) {
    showFatal(error);
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
    await preparePlayers(state.selectedProject);
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
          confirm("Delete this project and all its source audio and stems?")
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
        if (isPlaying()) {
          await pauseAll();
        } else if (state.selectedProject) await playAll(state.selectedProject);
        updatePlayerDisplay();
        break;
      case "mute":
        if (state.selectedProject && button.dataset.stem) {
          await toggleMute(state.selectedProject, button.dataset.stem as Stem);
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
    }
  } catch (error) {
    state.screenMessage = describeError(error);
    await render();
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
    state.selectedProject = await replaceSource(
      state.selectedProject,
      file,
      file.name,
    );
    state.screenMessage = "";
    await render();
  } catch (error) {
    state.screenMessage = describeError(error);
    await render();
  }
}

async function toggleMute(project: Project, stem: Stem): Promise<void> {
  const muted = project.mutedStems.includes(stem);
  const nextMuted = muted
    ? project.mutedStems.filter((item) => item !== stem)
    : [...project.mutedStems, stem];
  const updated = { ...project, mutedStems: nextMuted };
  applyStemVolume(updated, stem);
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
}

async function handleChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  if (target.type === "range" && target.id === "seek-bar") {
    seekAll(Number(target.value));
  }
  if (target.dataset.action === "volume" && state.selectedProject) {
    state.selectedProject = await saveProject(state.selectedProject);
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
root.addEventListener("change", (event) => {
  void handleChange(event).catch(showError);
});
root.addEventListener("change", (event) => {
  if ((event.target as HTMLElement).id === "audio-file") {
    void handleFileChange(event);
  }
});

window.addEventListener("pagehide", () => {
  terminateInferenceWorker();
  terminateUrlWorker();
  releasePlayers();
});
