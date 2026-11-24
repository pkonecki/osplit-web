import { knownGpu } from "../gpu";
import { modelDownloadBytes } from "../memory";
import { type ModelStatus, modelStatus } from "../model-cache";
import { appUrl } from "../paths";
import { state } from "../state";
import { storageEstimate } from "../storage";
import { MODEL_STEMS, type ModelId } from "../types";
import { gpuStatusText, messageMarkup, fileInputMarkup } from "./detail";
import { formatBytes } from "./format";
import { footerMarkup, pageHeader } from "./shell";

/**
 * Settings: storage on this device, the separation models (download or
 * delete them ahead of time), WebGPU, the link downloader, and about.
 */

const MODELS: { id: ModelId; name: string; detail: string }[] = [
  { id: "spleeter-5", name: "Spleeter", detail: "5 stems" },
  { id: "htdemucs-6s", name: "Demucs", detail: "6 stems · needs WebGPU" },
];

/** A model download started from Settings, and how far it got (0–1). */
export const modelDownload = { model: null as ModelId | null, progress: 0 };

export async function renderSettings(): Promise<string> {
  const estimate = await storageEstimate();
  const statuses = await Promise.all(MODELS.map((model) => modelStatus(model.id).catch(() => null)));
  const modelBytes = statuses.reduce((total, status) => total + (status?.bytes ?? 0), 0);
  const used = estimate?.usage ?? 0;
  const quota = estimate?.quota ?? 0;
  const projectBytes = Math.max(0, used - modelBytes);
  const share = (bytes: number) => quota ? Math.max(bytes > 0 ? 0.5 : 0, (bytes / quota) * 100) : 0;
  const gpu = knownGpu();
  const updateLabel = state.working && !state.taskProjectId ? "Checking for an update…" : "Check for update";
  return `
    <main class="content settings">
      ${pageHeader("Settings", { back: true })}
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
      <section class="card settings-section" aria-labelledby="settings-storage">
        <h2 id="settings-storage">Storage</h2>
        <div class="meter-row"><span>This device</span><span class="muted" id="storage-used">${
    estimate?.usage !== undefined
      ? `${formatBytes(used)}${quota ? ` of ${formatBytes(quota)} the browser allows` : ""}`
      : "Unknown"
  }</span></div>
        <div class="meter" aria-hidden="true"><span class="meter-projects" style="width:${share(projectBytes).toFixed(2)}%"></span><span class="meter-models" style="width:${
    share(modelBytes).toFixed(2)
  }%"></span></div>
        <div class="meter-legend">
          <span><span class="legend-dot projects"></span>Projects ${formatBytes(projectBytes)}</span>
          <span><span class="legend-dot models"></span>Models ${formatBytes(modelBytes)}</span>
        </div>
      </section>
      <section class="card settings-section" aria-labelledby="settings-models">
        <h2 id="settings-models">Separation models</h2>
        <p class="muted">Downloaded the first time you use them. Delete one to free space; it downloads again when you next split with it.</p>
        <div class="model-rows">${MODELS.map((model, index) => modelRow(model, statuses[index])).join("")}</div>
      </section>
      <section class="card settings-section" aria-labelledby="settings-device">
        <h2 id="settings-device">This device</h2>
        <p class="status-line"><span class="status-dot ${gpu.webgpu ? "ok" : "off"}" aria-hidden="true"></span>${
    gpu.webgpu ? "WebGPU available" : "No WebGPU"
  }</p>
        <p class="muted gpu-status">${gpuStatusText(gpu, null)}. ${
    gpu.webgpu
      ? "Separation runs on the GPU. Demucs needs WebGPU; Spleeter falls back to WebAssembly without it, more slowly."
      : "Spleeter separates on the CPU with WebAssembly, more slowly. Demucs needs WebGPU, which this browser doesn't offer."
  }</p>
      </section>
      <section class="card settings-section" aria-labelledby="settings-links">
        <h2 id="settings-links">Link downloads</h2>
        <div class="setting-row">
          <span><strong>Downloader (yt-dlp)</strong><small class="muted">Runs in your browser, only for sites that allow it.</small></span>
          <button class="button small" data-action="yt-update" ${state.working ? "disabled" : ""}>${updateLabel}</button>
        </div>
      </section>
      <section class="card settings-section" aria-labelledby="settings-about">
        <h2 id="settings-about">About OSplit Web</h2>
        <p class="muted">Separation and analysis run on this device; nothing is uploaded unless you connect your own cloud storage.</p>
        <p class="about-links"><a href="${appUrl("README-web.html")}">Browser limitations</a> · <a href="${
    appUrl("models/LICENSE-SPLEETER")
  }">Spleeter license</a> · <a href="${appUrl("models/LICENSE-DEMUCS")}">Demucs license</a></p>
      </section>
      ${footerMarkup()}
    </main>
    ${fileInputMarkup()}
  `;
}

function modelRow(model: { id: ModelId; name: string; detail: string }, status: ModelStatus | null): string {
  const downloading = modelDownload.model === model.id;
  const size = status?.downloaded ? status.bytes : modelDownloadBytes(model.id);
  const stateText = downloading
    ? `Downloading · ${Math.round(modelDownload.progress * 100)}%`
    : status?.downloaded
    ? "Downloaded"
    : "Not downloaded";
  const blocked = state.working || modelDownload.model !== null;
  const button = status?.downloaded
    ? `<button class="button small" data-action="model-delete" data-model="${model.id}" aria-label="Delete the ${model.name} model" ${
      blocked ? "disabled" : ""
    }>Delete</button>`
    : `<button class="button small" data-action="model-download" data-model="${model.id}" aria-label="Download the ${model.name} model" ${
      blocked ? "disabled" : ""
    }>${downloading ? "Downloading…" : "Download"}</button>`;
  return `
        <div class="model-row" data-model-row="${model.id}">
          <span class="model-row-text"><strong>${model.name} <small class="muted">· ${MODEL_STEMS[model.id].length} stems${
    model.id === "htdemucs-6s" ? " · needs WebGPU" : ""
  }</small></strong>
            <small class="model-state${status?.downloaded ? " ok" : ""}" id="model-state-${model.id}">${stateText}</small></span>
          <span class="muted model-size">${Math.round(size / 1_000_000)} MB</span>
          ${button}
        </div>`;
}

/** Updates a model row's progress in place while it downloads. */
export function updateModelProgress(): void {
  const model = modelDownload.model;
  if (!model) return;
  const element = document.querySelector<HTMLElement>(`#model-state-${model}`);
  if (element) element.textContent = `Downloading · ${Math.round(modelDownload.progress * 100)}%`;
}
