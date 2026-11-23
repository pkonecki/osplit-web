import { state } from "../state";
import { storageEstimate } from "../storage";
import type { Project } from "../types";
import { connection } from "../cloud/cloud";
import { cloudNote, cloudPanelMarkup } from "./cloud";
import { fileInputMarkup, messageMarkup } from "./detail";
import { escapeHtml, formatBytes, statusLabel } from "./format";
import { icon } from "./icons";
import { footerMarkup, pageHeader } from "./shell";

export async function renderProjects(): Promise<string> {
  const estimate = await storageEstimate();
  const used = estimate?.usage ? formatBytes(estimate.usage) : "unknown";
  const total = estimate?.quota
    ? formatBytes(estimate.quota)
    : "browser managed";
  const cloud = connection();
  return `
    <main class="content library">
      ${pageHeader("Library", {
    subtitle: cloud
      ? `Separation runs on this device. Projects sync to your ${escapeHtml(cloud.label)}.`
      : "Separation runs on this device. Your audio and projects stay in this browser.",
    actions: `<button class="icon-button mobile-only" data-action="settings" aria-label="Settings" ${
      state.working ? "disabled" : ""
    }>${icon("settings", 22)}</button>`,
  })}
      <div class="storage-note">Browser storage: ${used} used · ${total} available. Models are downloaded only when first needed.</div>
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
      <section class="create-card">
        <label for="new-project-name">Create a project</label>
        <div class="form-row">
          <input id="new-project-name" maxlength="80" placeholder="Project name (optional)" />
          <button class="button primary" data-action="create">Create project</button>
        </div>
        <div class="import-row">
          <span class="muted">Moving a project from another device? Export it there as a project file.</span>
          <button class="button subtle" data-action="import-project">Import project file</button>
        </div>
      </section>
      ${await cloudPanelMarkup()}
      <div class="section-heading"><h2>Saved projects</h2><span class="muted">${state.projects.length}</span></div>
      ${
    state.projects.length
      ? `<section class="project-list">${
        state.projects.map(projectCard).join("")
      }</section>`
      : `<section class="empty-card"><span class="empty-wave">▂ ▅ ▇ ▅ ▂</span><h3>No projects yet</h3><p class="muted">Create a project first. You can add audio or URL input at any time.</p></section>`
  }
      <p class="notice">Processing runs locally while this app is open. If the browser stops it, project state is saved and you can retry.</p>
      ${footerMarkup()}
    </main>
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
  }${escapeHtml(cloudNote(project))}</small>
        </span>
      </button>
      <button class="button text-button" data-action="export-project" data-id="${
    escapeHtml(project.id)
  }" aria-label="Export ${escapeHtml(project.name)} as a project file">Export</button>
      <button class="button danger-quiet" data-action="delete" data-id="${
    escapeHtml(project.id)
  }">Delete</button>
    </article>
  `;
}
