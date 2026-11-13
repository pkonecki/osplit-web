import { appUrl } from "../paths";
import { state } from "../state";
import { storageEstimate } from "../storage";
import type { Project } from "../types";
import { fileInputMarkup, messageMarkup } from "./detail";
import { escapeHtml, formatBytes, statusLabel } from "./format";

export async function renderProjects(): Promise<string> {
  const estimate = await storageEstimate();
  const used = estimate?.usage ? formatBytes(estimate.usage) : "unknown";
  const total = estimate?.quota
    ? formatBytes(estimate.quota)
    : "browser managed";
  const updateLabel = state.working
    ? "Checking / updating yt-dlp…"
    : "Check yt-dlp update";
  return `
    <header class="topbar">
      <a class="brand" href="#" aria-label="OSplit home">
        <span class="brand-mark"><img src="${appUrl("icon.svg")}" alt="" /></span>
        <span><strong>OSPLIT</strong><small>ON-DEVICE STEM STUDIO</small></span>
      </a>
      <button class="button subtle" data-action="yt-update" ${
    state.working ? "disabled" : ""
  }>${updateLabel}</button>
    </header>
    <main class="layout">
      <section class="intro">
        <p class="eyebrow">LOCAL STEM STUDIO</p>
        <h1>Your projects</h1>
        <p class="muted">Separate audio into vocals, piano, drums, bass, and other. Your audio and projects stay in this browser.</p>
        <div class="storage-note">Browser storage: ${used} used · ${total} available. Models are downloaded only when first needed.</div>
      </section>
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
      <section class="create-card">
        <label for="new-project-name">Create a project</label>
        <div class="form-row">
          <input id="new-project-name" maxlength="80" placeholder="Project name (optional)" />
          <button class="button primary" data-action="create">Create project</button>
        </div>
      </section>
      <div class="section-heading"><h2>Saved projects</h2><span class="muted">${state.projects.length}</span></div>
      ${
    state.projects.length
      ? `<section class="project-list">${
        state.projects.map(projectCard).join("")
      }</section>`
      : `<section class="empty-card"><span class="empty-wave">▂ ▅ ▇ ▅ ▂</span><h3>No projects yet</h3><p class="muted">Create a project first. You can add audio or URL input at any time.</p></section>`
  }
      <p class="notice">Processing runs locally while this app is open. If the browser stops it, project state is saved and you can retry.</p>
    </main>
    <footer>OSplit Web · local-only projects · <a href="${appUrl("README-web.html")}">Browser limitations</a></footer>
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
