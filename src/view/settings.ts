import { state } from "../state";
import { storageEstimate } from "../storage";
import { fileInputMarkup, messageMarkup } from "./detail";
import { formatBytes } from "./format";
import { footerMarkup, pageHeader } from "./shell";

/** The settings page: storage on this device and the link downloader. */
export async function renderSettings(): Promise<string> {
  const estimate = await storageEstimate();
  const used = estimate?.usage ? formatBytes(estimate.usage) : "unknown";
  const total = estimate?.quota ? formatBytes(estimate.quota) : "managed by the browser";
  const updateLabel = state.working ? "Checking / updating yt-dlp…" : "Check yt-dlp update";
  return `
    <main class="content settings">
      ${pageHeader("Settings", { back: true })}
      ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
      <section class="card settings-section" aria-labelledby="settings-storage">
        <h2 id="settings-storage">Storage on this device</h2>
        <p class="muted storage-note">Browser storage: ${used} used · ${total} available. Models are downloaded only when first needed.</p>
      </section>
      <section class="card settings-section" aria-labelledby="settings-links">
        <h2 id="settings-links">Links</h2>
        <p class="muted">Downloading from a link uses yt-dlp, run in your browser.</p>
        <button class="button secondary" data-action="yt-update" ${
    state.working ? "disabled" : ""
  }>${updateLabel}</button>
      </section>
      ${footerMarkup()}
    </main>
    ${fileInputMarkup()}
  `;
}
