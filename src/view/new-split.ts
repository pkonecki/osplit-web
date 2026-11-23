import { defaultModel, knownGpu, modelAvailable } from "../gpu";
import { modelDownloadBytes } from "../memory";
import { AUDIO_ACCEPT, isAudioFile, NOT_AUDIO_MESSAGE, projectNameFor } from "../tasks/import";
import { MODEL_STEMS, type ModelId, STEM_LABELS } from "../types";
import { formatBytes } from "./format";
import { icon } from "./icons";

/** What the New split dialog asks for: a source, a name and a model. */
export interface NewSplitRequest {
  name: string;
  model: ModelId;
  source: { file: File } | { url: string };
}

const MODELS: { id: ModelId; title: string; description: string }[] = [
  { id: "spleeter-5", title: "Spleeter", description: "Faster. Good for quick practice mixes." },
  { id: "htdemucs-6s", title: "Demucs", description: "Cleaner stems and a guitar track. Slower." },
];

/**
 * Opens the New split dialog (a modal on the page body, so re-renders
 * behind it don't close it), optionally with a file already chosen. Resolves
 * the request when the user starts the split, or null when they cancel.
 */
export function openNewSplit(initialFile?: File): Promise<NewSplitRequest | null> {
  const gpu = knownGpu();
  let file: File | null = initialFile ?? null;
  let sourceKind: "file" | "url" = "file";
  let model: ModelId = defaultModel(gpu);
  let nameTouched = false;

  const dialog = document.createElement("dialog");
  dialog.className = "sheet-dialog new-split";
  dialog.setAttribute("aria-labelledby", "new-split-title");
  dialog.innerHTML = `
    <form method="dialog" class="sheet-body" novalidate>
      <div class="sheet-head">
        <h2 id="new-split-title">New split</h2>
        <button type="button" class="icon-button" data-cancel aria-label="Close">${icon("close", 20)}</button>
      </div>
      <div class="sheet-content">
        <section class="field-group">
          <div class="field-row">
            <h3>Audio</h3>
            <div class="segmented" role="group" aria-label="Source">
              <button type="button" data-source="file" aria-pressed="true">File</button>
              <button type="button" data-source="url" aria-pressed="false">Link</button>
            </div>
          </div>
          <div class="source-file">
            <div class="file-card">
              <span class="file-icon">${icon("music", 22)}</span>
              <span class="file-text"><strong class="file-name">No file chosen</strong><small class="file-detail">MP3, WAV, FLAC, M4A or OGG · or drop it here</small></span>
              <button type="button" class="button small" data-choose-file>Choose a file</button>
            </div>
            <input type="file" accept="${AUDIO_ACCEPT}" hidden data-file-input />
          </div>
          <div class="source-url" hidden>
            <input id="new-split-url" class="text-input" type="url" inputmode="url" placeholder="https://…" aria-label="Audio or video link" autocomplete="off" />
            <small class="muted">Downloads in your browser, only from sites that allow it. YouTube and many others block this, so a local file is the reliable option.</small>
          </div>
          <p class="field-error" role="alert" hidden></p>
        </section>
        <section class="field-group">
          <label class="field-label" for="new-split-name">Name</label>
          <input id="new-split-name" class="text-input" type="text" maxlength="80" placeholder="Untitled project" autocomplete="off" />
        </section>
        <section class="field-group">
          <h3>Separation</h3>
          <div class="model-cards" role="radiogroup" aria-label="Separation model">${
    MODELS.map((option) => {
      const available = modelAvailable(option.id, gpu);
      const note = option.id === "spleeter-5"
        ? "Works in any browser, with or without WebGPU"
        : available
        ? "Needs WebGPU · available on this device"
        : "Needs WebGPU, which this browser doesn't offer";
      return `<button type="button" class="model-card" role="radio" data-model="${option.id}" aria-checked="false" ${
        available ? "" : "disabled"
      }>
              <span class="model-card-head"><span class="radio-dot" aria-hidden="true"></span><strong>${option.title}</strong><small>${
        `${Math.round(modelDownloadBytes(option.id) / 1_000_000)} MB`
      }</small></span>
              <span class="model-card-text">${option.description}</span>
              <span class="stem-chips">${
        MODEL_STEMS[option.id].map((stem) => `<span class="stem-chip stem-${stem}">${STEM_LABELS[stem]}</span>`).join("")
      }</span>
              <small class="model-card-note">${note}</small>
            </button>`;
    }).join("")
  }</div>
        </section>
      </div>
      <div class="sheet-foot">
        <span class="device-note"><span class="dot" aria-hidden="true"></span>Runs on this device · the model downloads once</span>
        <button type="button" class="button subtle" data-cancel>Cancel</button>
        <button class="button primary" value="start" data-start>Split</button>
      </div>
    </form>`;
  document.body.append(dialog);

  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const nameInput = $<HTMLInputElement>("#new-split-name");
  const urlInput = $<HTMLInputElement>("#new-split-url");
  const fileInput = $<HTMLInputElement>("[data-file-input]");
  const error = $<HTMLElement>(".field-error");
  const start = $<HTMLButtonElement>("[data-start]");

  const update = () => {
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-source]")) {
      button.setAttribute("aria-pressed", String(button.dataset.source === sourceKind));
    }
    $(".source-file").hidden = sourceKind !== "file";
    $(".source-url").hidden = sourceKind !== "url";
    $(".file-name").textContent = file ? file.name : "No file chosen";
    $(".file-detail").textContent = file
      ? formatBytes(file.size)
      : "MP3, WAV, FLAC, M4A or OGG · or drop it here";
    $("[data-choose-file]").textContent = file ? "Choose another" : "Choose a file";
    for (const card of dialog.querySelectorAll<HTMLButtonElement>("[data-model]")) {
      card.setAttribute("aria-checked", String(card.dataset.model === model));
      card.tabIndex = card.dataset.model === model ? 0 : -1;
    }
    start.textContent = `Split into ${MODEL_STEMS[model].length} stems`;
    const ready = sourceKind === "file" ? file !== null : urlInput.value.trim() !== "";
    start.disabled = !ready;
  };
  const setFile = (chosen: File) => {
    if (!isAudioFile(chosen)) {
      error.textContent = NOT_AUDIO_MESSAGE;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    file = chosen;
    sourceKind = "file";
    if (!nameTouched) nameInput.value = projectNameFor(chosen.name);
    update();
  };

  dialog.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const source = target.closest<HTMLElement>("[data-source]");
    if (source) {
      sourceKind = source.dataset.source === "url" ? "url" : "file";
      update();
      (sourceKind === "url" ? urlInput : $<HTMLButtonElement>("[data-choose-file]")).focus();
    }
    if (target.closest("[data-choose-file]")) fileInput.click();
    if (target.closest("[data-cancel]")) dialog.close("cancel");
    const card = target.closest<HTMLButtonElement>("[data-model]");
    if (card && !card.disabled) {
      model = card.dataset.model as ModelId;
      update();
    }
  });
  // Arrow keys move between the model cards, as in a radio group.
  dialog.addEventListener("keydown", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-model]");
    if (!card || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const cards = [...dialog.querySelectorAll<HTMLButtonElement>("[data-model]")].filter((c) => !c.disabled);
    const next = cards[(cards.indexOf(card) + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + cards.length) % cards.length];
    if (!next) return;
    event.preventDefault();
    model = next.dataset.model as ModelId;
    update();
    next.focus();
  });
  fileInput.addEventListener("change", () => {
    const chosen = fileInput.files?.[0];
    fileInput.value = "";
    if (chosen) setFile(chosen);
  });
  nameInput.addEventListener("input", () => {
    nameTouched = nameInput.value.trim() !== "";
  });
  urlInput.addEventListener("input", update);
  dialog.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
  });
  dialog.addEventListener("drop", (event) => {
    const dropped = event.dataTransfer?.files[0];
    if (!dropped) return;
    event.preventDefault();
    event.stopPropagation();
    setFile(dropped);
  });

  if (file) setFile(file);
  update();

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (dialog.returnValue !== "start") return resolve(null);
      const name = nameInput.value.trim() ||
        (sourceKind === "file" && file ? projectNameFor(file.name) : "Untitled project");
      resolve({
        name,
        model,
        source: sourceKind === "file" && file ? { file } : { url: urlInput.value.trim() },
      });
    }, { once: true });
    dialog.showModal();
    (file ? nameInput : $<HTMLButtonElement>("[data-choose-file]")).focus();
  });
}

/** Whether a New split dialog is open (drops go to it, not the page). */
export function newSplitOpen(): boolean {
  return document.querySelector("dialog.new-split[open]") !== null;
}
