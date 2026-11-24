import {
  autoSync,
  availableProviders,
  cloud,
  type CloudState,
  cloudState,
  cloudUsage,
  connection,
  lastSync,
  PROVIDER_LABELS,
} from "../cloud/cloud";
import type { RemoteProject } from "../cloud/sync";
import { relativeTime } from "../library";
import type { Project } from "../types";
import { escapeHtml, formatBytes } from "./format";
import { icon } from "./icons";

/**
 * Cloud sync on the pages: the section in Settings, the sync line in the
 * library, each project's sync state, and the dialog for a project changed
 * in two places. Nothing shows when no cloud is connected (Settings offers
 * to connect one, when this build has a provider).
 */

/** The Cloud sync section of Settings; empty when this build offers no provider. */
export function cloudSettingsMarkup(): string {
  const providers = availableProviders();
  if (!providers.length) return "";
  const current = connection();
  const intro = `<p class="muted">Uses your own ${
    providers.map((id) => PROVIDER_LABELS[id]).join(" or ")
  }. OSplit only reads and writes its own folder there.</p>`;
  if (!current) {
    return `
      <section class="card settings-section" aria-labelledby="settings-cloud">
        <h2 id="settings-cloud">Cloud sync</h2>
        ${intro}
        <div class="cloud-actions">${
      providers.map((id) =>
        `<button class="button secondary" data-action="cloud-connect" data-provider="${id}">Connect ${PROVIDER_LABELS[id]}</button>`
      ).join("")
    }</div>
        ${cloud.status ? `<p class="cloud-status muted" aria-live="polite">${escapeHtml(cloud.status)}</p>` : ""}
      </section>`;
  }
  const label = escapeHtml(current.label);
  const busy = cloud.busy ? 'aria-disabled="true"' : "";
  const quota = cloud.quota;
  const used = cloudUsage();
  const share = (bytes: number) => quota ? Math.max(bytes > 0 ? 0.5 : 0, Math.min(100, (bytes / quota.total) * 100)) : 0;
  return `
    <section class="card settings-section" aria-labelledby="settings-cloud">
      <h2 id="settings-cloud">Cloud sync</h2>
      ${intro}
      <div class="setting-row">
        <span class="cloud-mark" aria-hidden="true">${icon("cloud", 20)}</span>
        <span><strong>Connected to ${label}</strong><small class="muted">${
    current.account ? `as ${escapeHtml(current.account)}` : "Account name unknown"
  }</small></span>
        <button class="button small" data-action="cloud-disconnect" ${busy}>Disconnect</button>
      </div>
      ${
    cloud.needsReconnect
      ? `<p class="cloud-warning" role="alert">Your ${label} sign-in expired.
          <button class="button small" data-action="cloud-connect" data-provider="${current.provider}">Sign in again</button></p>`
      : ""
  }
      ${
    quota
      ? `<div class="meter-row"><span>${label} storage</span><span class="muted">${formatBytes(quota.used)} of ${
        formatBytes(quota.total)
      } used</span></div>
      <div class="meter" aria-hidden="true"><span class="meter-projects" style="width:${share(used).toFixed(2)}%"></span><span class="meter-other" style="width:${
        share(Math.max(0, quota.used - used)).toFixed(2)
      }%"></span></div>
      <div class="meter-legend"><span><span class="legend-dot projects"></span>OSplit ${formatBytes(used)}</span><span><span class="legend-dot other"></span>Other files</span><span>${
        formatBytes(Math.max(0, quota.total - quota.used))
      } free</span></div>`
      : `<p class="muted">OSplit's projects take ${formatBytes(used)} there. Sync to see the account's storage.</p>`
  }
      <label class="switch-row compact">
        <span><strong>Sync automatically</strong><small>Keeps projects that are both here and in ${label} up to date. Uploading or downloading a project is always manual.</small></span>
        <input type="checkbox" role="switch" class="switch" id="cloud-auto" ${autoSync() ? "checked" : ""} />
      </label>
      <div class="setting-row">
        <span class="cloud-status muted" aria-live="polite">${escapeHtml(cloud.status || lastSyncText())}</span>
        <button class="button small" data-action="cloud-sync" ${busy}>${cloud.busy ? "Syncing…" : "Sync now"}</button>
      </div>
    </section>`;
}

function lastSyncText(): string {
  const last = lastSync();
  return last ? `Last synced ${relativeTime(last)}` : "Not synced yet";
}

/** The library's sync line: the cloud, OSplit's share, the last sync, Sync now. */
export function syncLineMarkup(): string {
  const current = connection();
  if (!current) return "";
  const conflicts = cloud.conflicts.size;
  return `<span class="sync-line">
      <span class="sync-cloud">${icon("cloud", 15)}<span>${escapeHtml(current.label)} · ${formatBytes(cloudUsage())} used by OSplit</span></span>
      ${
    conflicts
      ? `<span class="sync-alert">${conflicts} project${conflicts === 1 ? " needs" : "s need"} you</span>`
      : `<span class="cloud-status muted" aria-live="polite">${escapeHtml(cloud.busy ? cloud.status || "Syncing…" : lastSyncText())}</span>`
  }
      <button class="button small" data-action="cloud-sync" ${cloud.busy ? 'aria-disabled="true"' : ""}>${
    cloud.busy ? "Syncing…" : "Sync now"
  }</button>
    </span>`;
}

const STATE_TEXT: Record<CloudState, string> = {
  synced: "In both places",
  changed: "Changed, not synced yet",
  conflict: "Changed in two places",
  local: "This device only",
  uploading: "Uploading…",
  downloading: "Downloading…",
};

/** A project's sync state for its row, or null when no cloud is connected. */
export function syncState(project: Project): { state: CloudState; label: string } | null {
  const state = cloudState(project.id, project.updatedAt);
  if (!state) return null;
  const label = connection()?.label ?? "the cloud";
  return { state, label: state === "synced" ? `In ${label} and here` : STATE_TEXT[state] };
}

/** The sync icon for a state. */
export function syncIcon(state: CloudState | "cloud"): string {
  return icon(state === "local" ? "device" : state === "conflict" ? "alert" : "cloud", 16);
}

/** A project only in the cloud, as a library row. */
export function remoteRowMarkup(project: RemoteProject): string {
  const id = escapeHtml(project.id);
  const name = escapeHtml(project.name);
  const label = escapeHtml(connection()?.label ?? "the cloud");
  const busy = cloud.busy ? "disabled" : "";
  return `
    <article class="project-row kind-cloud" data-kind="cloud" data-search="${escapeHtml(`${project.name} ${project.sourceName ?? ""}`)}">
      <span class="project-open">
        <span class="project-thumb" aria-hidden="true">${icon("cloud", 20)}</span>
        <span class="project-summary">
          <strong>${name}</strong>
          <small>${escapeHtml(project.sourceName ?? "No audio")} · ${escapeHtml(relativeTime(project.updatedAt))} · ${formatBytes(project.size)}</small>
        </span>
      </span>
      <span class="project-model"></span>
      <span class="project-music"></span>
      <span class="project-status"><span class="status-text">${cloud.transfers.get(project.id) ? "Downloading…" : `In ${label} only`}</span></span>
      <span class="project-actions">
        <button class="button small with-icon" data-action="cloud-download" data-id="${id}" ${busy} aria-label="Download ${name} to this device">${
    icon("download", 16)
  }Download</button>
        <button class="icon-button row-menu" data-action="remote-menu" data-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${name}">${
    icon("more", 20)
  }</button>
      </span>
    </article>`;
}

/**
 * Asks how to settle a project changed both here and in the cloud. Resolves
 * the choice, or null to decide later.
 */
export function conflictDialog(name: string, label: string, here: number, there: number): Promise<"here" | "cloud" | "both" | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog conflict-dialog";
  dialog.setAttribute("aria-labelledby", "conflict-title");
  const options = [
    { value: "here", title: "Keep this device's version", sub: `Changed here ${relativeTime(here)}. Replaces the copy in ${label}.` },
    { value: "cloud", title: `Keep the ${label} version`, sub: `Changed on another device ${relativeTime(there)}. Replaces the copy here.` },
    { value: "both", title: "Keep both", sub: `Saves the ${label} version here as a second project, "${name} (other device)".` },
  ];
  dialog.innerHTML = `
    <form method="dialog">
      <h2 class="dialog-title" id="conflict-title">${icon("alert", 20)} ${escapeHtml(name)} changed in two places</h2>
      <p>It was changed on this device and in ${escapeHtml(label)} since the last sync. Sync leaves it alone until you choose which version to keep.</p>
      <div class="choice-list" role="radiogroup" aria-label="Version to keep">${
    options.map((option, index) =>
      `<label class="choice"><input type="radio" name="conflict" value="${option.value}" ${index === 2 ? "checked" : ""} /><span><strong>${
        escapeHtml(option.title)
      }</strong><small>${escapeHtml(option.sub)}</small></span></label>`
    ).join("")
  }</div>
      <div class="dialog-actions">
        <button type="button" class="button subtle" data-later>Decide later</button>
        <button class="button primary" value="keep">Keep</button>
      </div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelector("[data-later]")!.addEventListener("click", () => dialog.close(""));
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const picked = dialog.querySelector<HTMLInputElement>('input[name="conflict"]:checked')?.value;
      resolve(dialog.returnValue === "keep" && (picked === "here" || picked === "cloud" || picked === "both") ? picked : null);
      dialog.remove();
    }, { once: true });
    dialog.showModal();
  });
}
