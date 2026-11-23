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
  type Quality,
} from "../types";
import { escapeHtml, statusLabel } from "./format";
import { renderMixer } from "./mixer";
import { footerMarkup, pageHeader } from "./shell";

export function renderDetail(project: Project): string {
  const complete = project.completedStems.length > 0;
  const model = projectModel(project);
  const gpu = knownGpu();
  // Saved with Demucs, opened where it cannot run: the stems stay, but a new
  // separation needs Spleeter.
  const blocked = !modelAvailable(model, gpu);
  const busy = state.working || project.status === "processing";
  // Marked as processing but not by this tab: another tab holds its lock.
  const elsewhere = !state.working && project.status === "processing";
  return `
    <main class="content detail">
      ${pageHeader(escapeHtml(project.name), {
    back: true,
    subtitle: `Saved in this browser · ${escapeHtml(project.sourceName ?? "No audio source yet")}`,
    actions: `<button class="button subtle" data-action="export-project" data-id="${
      escapeHtml(project.id)
    }" title="Save this project with its audio, stems and analysis, to open it in OSplit on another device">Export project file</button>`,
  })}
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
      <section class="source-row">
        <button class="button secondary" data-action="import" ${
    busy ? "disabled" : ""
  }>Choose audio file</button>
        <div class="url-input"><input id="media-url" type="url" inputmode="url" placeholder="https://… (best effort)" aria-label="Audio or video URL" /><button class="button secondary" data-action="download-url" ${
    busy ? "disabled" : ""
  }>Download URL</button></div>
        ${
    urlTaskActive()
      ? `<button class="button outline" data-action="cancel">Cancel download</button>`
      : ""
  }
      </section>
      <p class="hint">URL download runs entirely in your browser and works only when the provider permits browser access. YouTube and many sites block this; importing a local audio file is the reliable option.</p>
      ${renderModelPicker(project, gpu, busy)}
      ${
    project.sourceName && project.sourceRemoved && !busy
      ? `<section class="empty-card compact source-removed"><h3>Source audio removed</h3><p class="muted">It was deleted after separation to save space. Import it again to re-separate.</p></section>`
      : project.sourceName
      ? `<section class="process-card">
              <button class="button primary" data-action="${
        busy ? "cancel" : "separate"
      }" ${elsewhere || (blocked && !busy) ? "disabled" : ""}>${
        urlTaskActive()
          ? "Cancel download"
          : elsewhere
          ? "Processing in another tab…"
          : busy
          ? "Cancel processing"
          : complete
          ? "Separate again"
          : project.status === "interrupted"
          ? "Retry separation"
          : `Separate ${STEM_COUNT_WORDS[MODEL_STEMS[model].length]} stems`
      }</button>
              <label class="check-row"><input type="checkbox" data-action="delete-source-option" ${
        project.deleteSourceAfterSeparation ? "checked" : ""
      } ${
        busy ? "disabled" : ""
      } /> Delete the source audio after separating <small class="muted">(saves space; re-separating needs the file again)</small></label>
              <div class="progress-track" role="progressbar" aria-label="Separation progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${
        progressValue()
      }" aria-valuetext="${
        escapeHtml(progressText(project))
      }"><span style="width:${progressValue()}%"></span></div>
              <div class="progress-copy"><span>${
        escapeHtml(state.progressLabel || statusLabel(project.status))
      }</span><span>${busy ? `${state.progress}%` : ""}</span></div>
              ${project.errorMessage ? messageMarkup(project.errorMessage) : ""}
            </section>`
      : `<section class="empty-card compact"><h3>Add a source track</h3><p class="muted">Choose an audio file from this device to enable separation.</p></section>`
  }
      ${complete ? renderMixer(project) : ""}
      <p class="notice">The browser may suspend processing when this tab is in the background. Task status is saved, but work is not guaranteed to continue after the tab is closed.</p>
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
  const quality = (id: Quality, title: string) =>
    `<button class="quality ${project.quality === id ? "selected" : ""}" data-action="quality" data-quality="${id}" ${
      busy ? "disabled" : ""
    }>${title} <small>${id.toUpperCase()} · ${
      megabytes(modelDownloadBytes("spleeter-5", id))
    }</small></button>`;
  const hint = model === "htdemucs-6s"
    ? demucsOk
      ? "Demucs separates better than Spleeter but takes longer: about 1.2× Spleeter High quality on a desktop GPU, more on weaker ones. Its piano stem is weak (its authors say so)."
      : "Demucs needs WebGPU, which this browser does not offer. Choose Spleeter to separate here; the saved stems stay."
    : "Spleeter is fast and runs on any device.";
  return `
      <section class="quality-row">
        <div><h2>Separation model</h2><p class="muted gpu-status">${
    escapeHtml(gpuStatusText(gpu, busy ? state.provider : null))
  }</p><p class="muted">Models are downloaded and cached on first use.</p></div>
        <div class="quality-buttons">
          ${option("spleeter-5", "Spleeter", "5 stems · fast", true)}
          ${
    option(
      "htdemucs-6s",
      "Demucs v4",
      demucsOk
        ? `6 stems · better, slower · ${megabytes(modelDownloadBytes("htdemucs-6s", "fp32"))}`
        : "Needs WebGPU",
      demucsOk,
    )
  }
        </div>
      </section>
      ${
    model === "spleeter-5"
      ? `<section class="quality-row">
        <div><h2>Spleeter quality</h2></div>
        <div class="quality-buttons">
          ${quality("fp32", "High quality")}
          ${quality("fp16", "Low quality")}
        </div>
      </section>`
      : ""
  }
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

function progressValue(): number {
  return Math.round(Math.max(0, Math.min(100, state.progress)));
}

function progressText(project?: Project): string {
  const stage = state.progressLabel ||
    (project ? statusLabel(project.status) : "");
  return `${stage} · ${progressValue()}%`;
}

export function updateProgressDisplay(): void {
  const track = document.querySelector<HTMLElement>(".progress-track");
  track?.setAttribute("aria-valuenow", String(progressValue()));
  track?.setAttribute("aria-valuetext", progressText());
  const bar = document.querySelector<HTMLElement>(".progress-track span");
  const stage = document.querySelector<HTMLElement>(
    ".progress-copy span:first-child",
  );
  const value = document.querySelector<HTMLElement>(
    ".progress-copy span:last-child",
  );
  if (bar) bar.style.width = `${state.progress}%`;
  if (stage) stage.textContent = state.progressLabel;
  if (value) value.textContent = `${state.progress}%`;
}
