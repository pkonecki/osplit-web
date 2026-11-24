import { type GpuSupport, knownGpu, modelAvailable } from "../gpu";
import { modelDownloadBytes } from "../memory";
import { state } from "../state";
import { AUDIO_ACCEPT } from "../tasks/import";
import { urlTaskActive } from "../tasks/url-download";
import {
  MODEL_STEMS,
  type ModelId,
  type Project,
  projectModel,
} from "../types";
import { escapeHtml } from "./format";
import { renderPractice } from "./practice-view";
import { renderProgressView } from "./progress-view";
import { footerMarkup, pageHeader } from "./shell";

/** "Split again" on a separated project shows the source and model choices. */
let setupOpen = false;

export function setSetupOpen(open: boolean): void {
  setupOpen = open;
}

export function renderDetail(project: Project): string {
  const complete = project.completedStems.length > 0;
  if (complete && project.status !== "processing" && !setupOpen) return renderPractice(project);
  const gpu = knownGpu();
  const model = projectModel(project);
  // Saved with Demucs, opened where it cannot run: the stems stay, but a new
  // separation needs Spleeter.
  const blocked = !modelAvailable(model, gpu);
  // A split runs (in this tab, or in another that holds the project's lock).
  const splitting = project.status === "processing" && !urlTaskActive();
  const downloading = urlTaskActive() && state.selectedProject?.id === project.id;
  // Another task of this tab, on another project.
  const elsewhere = state.working && !downloading && state.taskProjectId !== project.id;
  const busy = state.working || project.status === "processing";
  return `
    <main class="content detail">
      ${pageHeader(escapeHtml(project.name), {
    back: true,
    subtitle: `${escapeHtml(project.sourceName ?? "No audio source yet")} · ${
      model === "htdemucs-6s" ? "Demucs" : "Spleeter"
    } · ${MODEL_STEMS[model].length} stems`,
    actions: `<button class="button subtle" data-action="export-project" data-id="${
      escapeHtml(project.id)
    }" title="Save this project with its audio, stems and analysis, to open it in OSplit on another device" ${
      splitting ? "disabled" : ""
    }>Export project file</button>`,
  })}
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
      ${
    splitting ? renderProgressView(project) : `
      <section class="source-row">
        <button class="button secondary" data-action="import" ${
      busy ? "disabled" : ""
    }>Choose audio file</button>
        <div class="url-input"><input id="media-url" type="url" inputmode="url" placeholder="https://… (best effort)" aria-label="Audio or video URL" /><button class="button secondary" data-action="download-url" ${
      busy ? "disabled" : ""
    }>Download URL</button></div>
        ${downloading ? `<button class="button outline" data-action="cancel">Cancel download</button>` : ""}
      </section>
      <p class="hint">URL download runs entirely in your browser and works only when the provider permits browser access. YouTube and many sites block this; importing a local audio file is the reliable option.</p>
      ${renderModelPicker(project, gpu, busy)}
      ${
      project.sourceName && project.sourceRemoved && !busy
        ? `<section class="empty-card compact source-removed"><h3>Source audio removed</h3><p class="muted">It was deleted after separation to save space. Import it again to re-separate.</p></section>`
        : project.sourceName && !downloading
        ? `<section class="process-card">
              ${statusMarkup(project)}
              <button class="button primary" data-action="separate" ${
          busy || blocked ? "disabled" : ""
        }>${
          elsewhere
            ? "Another split is running…"
            : complete
            ? "Separate again"
            : project.status === "interrupted" || project.status === "failed"
            ? "Retry separation"
            : `Separate ${STEM_COUNT_WORDS[MODEL_STEMS[model].length]} stems`
        }</button>
            </section>`
        : downloading
        ? ""
        : `<section class="empty-card compact"><h3>Add a source track</h3><p class="muted">Choose an audio file from this device to enable separation.</p></section>`
    }`
  }
      ${
    complete && !splitting
      ? `<button class="button subtle" data-action="split-cancel">Back to practice</button>`
      : ""
  }
      ${
    splitting
      ? ""
      : `<p class="notice">The browser may suspend processing when this tab is in the background. Task status is saved, but work is not guaranteed to continue after the tab is closed.</p>`
  }
      ${footerMarkup()}
    </main>
    ${fileInputMarkup()}
  `;
}

const STEM_COUNT_WORDS: Record<number, string> = { 5: "five", 6: "six" };

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** What the browser's WebGPU means for separation, or where it runs now. */
export function gpuStatusText(gpu: GpuSupport, running: "webgpu" | "wasm" | null): string {
  if (running === "webgpu") return "Separating on the GPU (WebGPU)";
  if (running === "wasm") return "Separating on the CPU – WebGPU is not in use";
  if (!gpu.webgpu) return "WebGPU: not available – separation runs on the CPU";
  return "WebGPU: available";
}

function renderModelPicker(project: Project, gpu: GpuSupport, busy: boolean): string {
  const model = projectModel(project);
  const demucsOk = modelAvailable("htdemucs-6s", gpu);
  const option = (id: ModelId, title: string, detail: string, enabled: boolean) =>
    `<button class="quality ${model === id ? "selected" : ""}" data-action="model" data-model="${id}" ${
      busy || !enabled ? "disabled" : ""
    }>${title} <small>${detail}</small></button>`;
  const hint = model === "htdemucs-6s"
    ? demucsOk
      ? "Demucs separates better than Spleeter but takes longer: about 1.2× Spleeter on a desktop GPU, more on weaker ones. Its piano stem is weak (its authors say so)."
      : "Demucs needs WebGPU, which this browser does not offer. Choose Spleeter to separate here; the saved stems stay."
    : "Spleeter is fast and runs on any device.";
  return `
      <section class="quality-row">
        <div><h2>Separation model</h2><p class="muted gpu-status">${
    escapeHtml(gpuStatusText(gpu, busy ? state.provider : null))
  }</p><p class="muted">Models are downloaded and cached on first use.</p></div>
        <div class="quality-buttons">
          ${option("spleeter-5", "Spleeter", `5 stems · fast · ${megabytes(modelDownloadBytes("spleeter-5"))}`, true)}
          ${
    option(
      "htdemucs-6s",
      "Demucs v4",
      demucsOk
        ? `6 stems · better, slower · ${megabytes(modelDownloadBytes("htdemucs-6s"))}`
        : "Needs WebGPU",
      demucsOk,
    )
  }
        </div>
      </section>
      <p class="hint model-hint">${escapeHtml(hint)}</p>`;
}

export function fileInputMarkup(): string {
  // The project file input has no accept list: iOS greys out files whose
  // extension it doesn't know, such as .osplit. The file is checked on import.
  return `<input id="audio-file" type="file" accept="${AUDIO_ACCEPT}" hidden />
    <input id="project-file" type="file" hidden />`;
}

export function messageMarkup(message: string): string {
  return `<div class="message" role="status"><span>${
    escapeHtml(message)
  }</span><button data-action="dismiss" aria-label="Dismiss">×</button></div>`;
}

/** Why the last split stopped, above the button that starts it again. */
function statusMarkup(project: Project): string {
  if (project.status !== "interrupted" && project.status !== "failed") return "";
  const progress = Math.round(project.taskProgress ?? 0);
  return `<div class="split-stopped ${project.status}">
      <strong>${project.status === "failed" ? "The split failed" : "Split stopped"}${
    progress > 0 ? ` at ${progress}%` : ""
  }</strong>
      <span>${escapeHtml(project.errorMessage ?? "Start it again to finish it.")}</span>
    </div>`;
}
