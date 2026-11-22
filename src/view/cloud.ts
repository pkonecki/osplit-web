import {
  autoSync,
  availableProviders,
  cloud,
  cloudState,
  connection,
  PROVIDER_LABELS,
  remoteOnlyProjects,
} from "../cloud/cloud";
import type { RemoteProject } from "../cloud/sync";
import type { Project } from "../types";
import { escapeHtml, formatBytes } from "./format";

/** The cloud storage panel; empty when this build offers no provider. */
export async function cloudPanelMarkup(): Promise<string> {
  const providers = availableProviders();
  if (!providers.length) return "";
  const current = connection();
  if (!current) {
    return `
      <section class="cloud-card">
        <div class="cloud-heading"><h2>Cloud storage</h2><span class="muted">Optional</span></div>
        <p class="muted">Sync your projects to your own ${
      providers.map((id) => PROVIDER_LABELS[id]).join(" or ")
    } to open them on your other devices. OSplit only uses its own folder there.</p>
        <div class="cloud-actions">${
      providers.map((id) =>
        `<button class="button subtle" data-action="cloud-connect" data-provider="${id}">Connect ${
          PROVIDER_LABELS[id]
        }</button>`
      ).join("")
    }</div>
        ${cloud.status ? `<p class="cloud-status muted" aria-live="polite">${escapeHtml(cloud.status)}</p>` : ""}
      </section>`;
  }
  const label = escapeHtml(current.label);
  const account = current.account ? ` as ${escapeHtml(current.account)}` : "";
  const busy = cloud.busy ? 'aria-disabled="true"' : "";
  const remoteOnly = await remoteOnlyProjects();
  return `
    <section class="cloud-card">
      <div class="cloud-heading"><h2>Cloud storage</h2><span class="muted">${label}</span></div>
      <p>Connected to <strong>${label}</strong>${account}.</p>
      ${
    cloud.needsReconnect
      ? `<p class="cloud-warning">Your ${label} sign-in expired.
          <button class="button subtle" data-action="cloud-connect" data-provider="${current.provider}">Sign in again</button></p>`
      : ""
  }
      <div class="cloud-actions">
        <button class="button primary" data-action="cloud-sync" ${busy}>${
    cloud.busy ? "Syncing…" : "Sync now"
  }</button>
        <label class="check-row"><input type="checkbox" id="cloud-auto" ${
    autoSync() ? "checked" : ""
  } /> Sync automatically</label>
        <button class="button text-button" data-action="cloud-disconnect" ${busy}>Disconnect</button>
      </div>
      <p class="cloud-status muted" aria-live="polite">${escapeHtml(cloud.status)}</p>
      ${
    remoteOnly.length
      ? `<h3 class="cloud-subheading">In ${label}, not on this device</h3>
         <div class="project-list">${remoteOnly.map((project) => remoteCard(project, label, busy)).join("")}</div>`
      : ""
  }
    </section>`;
}

function remoteCard(project: RemoteProject, label: string, busy: string): string {
  const id = escapeHtml(project.id);
  const name = escapeHtml(project.name);
  return `
    <article class="project-card remote-card">
      <span class="project-open">
        <span class="project-symbol">☁</span>
        <span class="project-summary">
          <strong>${name}</strong>
          <small>${escapeHtml(project.sourceName ?? "No audio source")} · ${formatBytes(project.size)}</small>
        </span>
      </span>
      <button class="button text-button" data-action="cloud-download" data-id="${id}" ${busy}
        aria-label="Download ${name} from ${label}">Download</button>
      <button class="button danger-quiet" data-action="cloud-remove" data-id="${id}" ${busy}
        aria-label="Remove ${name} from ${label}">Remove</button>
    </article>`;
}

/** The project card's sync note, e.g. " · In Dropbox". */
export function cloudNote(project: Project): string {
  const current = connection();
  const state = current && cloudState(project.id, project.updatedAt);
  if (!current || !state) return "";
  const label = current.label;
  return ` · ${
    state === "synced" ? `In ${label}` : state === "changed" ? "Changed since last sync" : `Not in ${label} yet`
  }`;
}
