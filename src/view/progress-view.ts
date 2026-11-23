import { modelDownloadBytes } from "../memory";
import { state } from "../state";
import { type Project, projectModel } from "../types";
import { MODEL_PHASE_PERCENT } from "../progress";
import { escapeHtml } from "./format";
import { icon } from "./icons";

/**
 * The splitting-in-progress view: the overall progress, the steps of the
 * split, Cancel, and the option to delete the original audio when done.
 * The card updates in place as the worker reports progress.
 */

/** Where a split stands, from the running task (or the saved project). */
export interface SplitProgress {
  /** 0–100, as the worker reports it: models first, then the stems. */
  progress: number;
  stage: string;
  /** This tab runs it; false when another tab does. */
  here: boolean;
}

export function splitProgress(project: Project): SplitProgress {
  const here = state.working && state.taskProjectId === project.id;
  return here
    ? { progress: state.progress, stage: state.progressLabel || "Preparing audio", here }
    : { progress: project.taskProgress ?? 0, stage: project.taskStage || "Processing", here };
}

type StepState = "done" | "active" | "pending";

/** The steps a split goes through, and which is running. */
export function splitSteps(
  project: Project,
  { progress, stage }: SplitProgress,
): { label: string; note: string; state: StepState }[] {
  const model = projectModel(project);
  const preparing = stage === "Preparing audio" && progress === 0;
  const modelDone = !preparing && progress >= MODEL_PHASE_PERCENT;
  const step = (done: boolean, active: boolean): StepState => done ? "done" : active ? "active" : "pending";
  const megabytes = Math.round(modelDownloadBytes(model) / 1_000_000);
  return [
    { label: "Preparing audio", note: preparing ? "" : "Done", state: step(!preparing, preparing) },
    {
      label: `Getting ${model === "htdemucs-6s" ? "Demucs" : "Spleeter"}`,
      note: modelDone ? "Done" : `${megabytes} MB · downloads once`,
      state: step(modelDone, !preparing && !modelDone),
    },
    {
      label: "Separating stems",
      note: progress >= 100 ? "Done" : modelDone ? `${Math.round(progress)}%` : "",
      state: step(progress >= 100, modelDone && progress < 100),
    },
    { label: "Detecting tempo, beats, key and chords", note: "Next", state: "pending" },
  ];
}

/** "About 3 min left", from how long the split has run so far. */
export function timeLeft(progress: number, elapsedMs: number): string {
  // Model downloads and loading say little about the separation's pace.
  if (progress <= MODEL_PHASE_PERCENT + 2 || elapsedMs <= 0) return "Working out the time left…";
  const remaining = (elapsedMs * (100 - progress)) / progress / 1000;
  if (remaining < 60) return "Less than a minute left";
  return `About ${Math.ceil(remaining / 60)} min left`;
}

export function renderProgressCard(project: Project): string {
  const split = splitProgress(project);
  const value = Math.round(Math.max(0, Math.min(100, split.progress)));
  const steps = splitSteps(project, split);
  const active = steps.find((item) => item.state === "active");
  const stageText = split.here ? active?.label ?? split.stage : "Splitting in another tab";
  const left = split.here
    ? timeLeft(value, state.taskStartedAt ? Date.now() - state.taskStartedAt : 0)
    : "Open that tab to follow it or cancel it.";
  return `
      <div class="progress-head" aria-live="polite">
        <span class="progress-value" id="progress-value">${value}%</span>
        <span class="progress-stage"><strong id="progress-stage">${escapeHtml(stageText)}</strong><small>${
    escapeHtml(left)
  }</small></span>
      </div>
      <div class="progress-track" role="progressbar" aria-label="Separation progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-valuetext="${
    escapeHtml(`${split.stage} · ${value}%`)
  }"><span style="width:${value}%"></span></div>
      <ol class="split-steps">${
    steps.map((item) =>
      `<li class="step-${item.state}"><span class="step-dot" aria-hidden="true">${
        item.state === "done" ? icon("check", 12) : ""
      }</span><span class="step-label">${escapeHtml(item.label)}</span><span class="step-note">${
        escapeHtml(item.note)
      }</span></li>`
    ).join("")
  }</ol>`;
}

export function renderProgressView(project: Project): string {
  const split = splitProgress(project);
  const where = state.provider === "webgpu"
    ? "Running on this device with WebGPU."
    : state.provider === "wasm"
    ? "Running on this device's CPU (WebGPU is not in use)."
    : "Running on this device.";
  return `
      <section class="card progress-card" aria-label="Progress" id="progress-card">
        ${renderProgressCard(project)}
      </section>
      ${
    split.here
      ? `<p class="info-note">${icon("device", 18)}<span>${
        where
      } Keep this tab open; the screen stays awake. You can browse your library meanwhile. If the tab closes, the split stops and you can resume it later.</span></p>
      <label class="switch-row">
        <span><strong>Delete the original audio when done</strong><small>Saves space. Splitting it again, for example with the other model, will need the file again.</small></span>
        <input type="checkbox" role="switch" class="switch" data-action="delete-source-option" ${
        project.deleteSourceAfterSeparation ? "checked" : ""
      } />
      </label>
      <button class="button danger-outline" data-action="cancel">Cancel split</button>`
      : `<p class="info-note">${icon("device", 18)}<span>This project is being split in another tab or window of OSplit. It stays there until it finishes.</span></p>`
  }
`;
}

/** Updates the progress card in place (called on every progress report). */
export function updateProgressDisplay(): void {
  const card = document.querySelector<HTMLElement>("#progress-card");
  const project = state.selectedProject;
  if (card && project?.id === state.taskProjectId) card.innerHTML = renderProgressCard(project);
  // The library row of the split, while the library is shown.
  const row = document.querySelector<HTMLElement>(".project-row.kind-busy.here");
  if (row) {
    const value = Math.round(state.progress);
    const text = row.querySelector<HTMLElement>(".status-text");
    const bar = row.querySelector<HTMLElement>(".status-bar span");
    if (text) text.textContent = `Separating · ${value}%`;
    if (bar) bar.style.width = `${value}%`;
  }
}
