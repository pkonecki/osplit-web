import { appUrl } from "../paths";
import { state } from "../state";
import { urlTaskActive } from "../tasks/url-download";
import type { Project } from "../types";
import { escapeHtml, statusLabel } from "./format";
import { renderMixer } from "./mixer";

export function renderDetail(project: Project): string {
  const complete = project.completedStems.length > 0;
  const busy = state.working || project.status === "processing";
  // Marked as processing but not by this tab: another tab holds its lock.
  const elsewhere = !state.working && project.status === "processing";
  return `
    <header class="topbar">
      <button class="brand brand-button" data-action="home">
        <span class="brand-mark"><img src="${appUrl("icon.svg")}" alt="" /></span>
        <span><strong>OSPLIT</strong><small>ON-DEVICE STEM STUDIO</small></span>
      </button>
      <button class="button subtle" data-action="home" ${
    state.working ? "disabled" : ""
  }>Projects</button>
    </header>
    <main class="layout detail">
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
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
    urlTaskActive()
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
      }" ${elsewhere ? "disabled" : ""}>${
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
          : "Separate five stems"
      }</button>
              <div class="progress-track"><span style="width:${
        Math.max(0, Math.min(100, state.progress))
      }%"></span></div>
              <div class="progress-copy"><span>${
        escapeHtml(state.progressLabel || statusLabel(project.status))
      }</span><span>${busy ? `${state.progress}%` : ""}</span></div>
              ${project.errorMessage ? messageMarkup(project.errorMessage) : ""}
            </section>`
      : `<section class="empty-card compact"><h3>Add a source track</h3><p class="muted">Choose an audio file from this device to enable separation.</p></section>`
  }
      ${complete ? renderMixer(project) : ""}
      <p class="notice">The browser may suspend processing when this tab is in the background. Task status is saved, but work is not guaranteed to continue after the tab is closed.</p>
    </main>
    <footer>OSplit Web · IndexedDB local storage · <a href="${appUrl("README-web.html")}">Browser limitations</a></footer>
    ${fileInputMarkup()}
  `;
}

export function fileInputMarkup(): string {
  return `<input id="audio-file" type="file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus,.webm" hidden />`;
}

export function messageMarkup(message: string): string {
  return `<div class="message" role="status"><span>${
    escapeHtml(message)
  }</span><button data-action="dismiss" aria-label="Dismiss">×</button></div>`;
}

export function updateProgressDisplay(): void {
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
