import { state } from "../state";
import { MODEL_STEMS, type Project, projectModel } from "../types";
import { chartMarkup } from "./chart";
import { markersMarkup } from "./markers-view";
import { messageMarkup } from "./detail";
import { escapeHtml } from "./format";
import { nowNextMarkup } from "./harmony";
import { icon } from "./icons";
import { mixerMarkup } from "./mixer";
import { exportPanel, keyPanel, loopPanel, panelChip, speedPanel } from "./panels";
import { playerMarkup } from "./player-bar";

/**
 * The practice view of a separated project: the chord chart with the
 * practice chips above it, the mixer beside it (a tab on phones, a panel
 * that opens and closes on narrow desktops), and the player at the bottom.
 */

export type PracticeTab = "chords" | "mixer";
let tab: PracticeTab = "chords";
let mixerOpen = false;

export function practiceTab(): PracticeTab {
  return tab;
}

/** Shows the chart or the mixer on a phone, in place. */
export function setPracticeTab(next: PracticeTab): void {
  tab = next;
  const root = document.querySelector<HTMLElement>(".practice");
  if (root) root.dataset.tab = next;
  for (const button of document.querySelectorAll<HTMLElement>("[data-action='practice-tab']")) {
    const current = button.dataset.tab === next;
    button.classList.toggle("current", current);
    if (current) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

/** Opens or closes the mixer panel on a narrow desktop, in place. */
export function toggleMixerPanel(): void {
  mixerOpen = !mixerOpen;
  document.querySelector(".practice")?.classList.toggle("mixer-open", mixerOpen);
  document.querySelector(".practice-header [data-action='mixer-toggle']")?.setAttribute("aria-pressed", String(mixerOpen));
  if (mixerOpen) document.querySelector<HTMLElement>(".mixer-close")?.focus();
}

export function renderPractice(project: Project): string {
  const model = projectModel(project);
  const source = project.sourceName ? `${escapeHtml(project.sourceName)} · ` : "";
  return `
    <div class="practice-page">
    <div class="practice${mixerOpen ? " mixer-open" : ""}" data-tab="${tab}">
      <div class="practice-main">
        <header class="practice-header">
          <button class="icon-button mobile-only" data-action="home" aria-label="Back to library">${icon("back", 22)}</button>
          <div class="practice-title">
            <h1>${escapeHtml(project.name)}</h1>
            <p class="page-subtitle">${source}${model === "htdemucs-6s" ? "Demucs" : "Spleeter"} · ${
    MODEL_STEMS[model].length
  } stems</p>
            <button class="mobile-meta" data-action="panel" data-panel="rhythm" aria-haspopup="dialog" aria-expanded="false" aria-label="Rhythm settings"><span id="practice-meta"></span></button>
          </div>
          <div class="info-chips desktop-only">
            <span class="info-chip" id="song-key-chip">Key…</span>
            <button class="info-chip" data-action="panel" data-panel="rhythm" aria-haspopup="dialog" aria-expanded="false" title="Rhythm settings"><span id="tempo-chip">…</span></button>
            <button class="info-chip" data-action="panel" data-panel="rhythm" aria-haspopup="dialog" aria-expanded="false" title="Beats per measure"><span id="metre-chip">—</span></button>
          </div>
          <button class="button subtle with-icon tablet-only" data-action="mixer-toggle" aria-pressed="${mixerOpen}">${
    icon("mixer", 18)
  }Mixer</button>
          <div class="popover-anchor align-end desktop-only">
            <button class="button subtle with-icon" data-action="panel" data-panel="export" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel-export">${
    icon("export", 18)
  }Export</button>
          </div>
          <button class="icon-button" data-action="project-menu" aria-haspopup="menu" aria-label="More options">${icon("more", 22)}</button>
        </header>
        ${state.screenMessage ? messageMarkup(state.screenMessage) : ""}
        <div class="practice-toolbar">
          <div class="popover-anchor">${panelChip("speed", "Speed", "speed-chip-value")}${speedPanel(project)}</div>
          <div class="popover-anchor">${panelChip("key", "Key", "key-chip-value")}${keyPanel()}</div>
          <div class="popover-anchor">${panelChip("loop", "Loop", "loop-chip-value")}${loopPanel()}</div>
          ${nowNextMarkup()}
        </div>
        <div class="chart-area">${markersMarkup()}${chartMarkup()}</div>
      </div>
      ${mixerMarkup(project)}
    </div>
    ${playerMarkup(project)}
    <nav class="practice-tabs mobile-only" aria-label="Views">
      <button class="tab-button${tab === "chords" ? " current" : ""}" data-action="practice-tab" data-tab="chords" ${
    tab === "chords" ? 'aria-current="page"' : ""
  }>${icon("chords", 20)}Chords</button>
      <button class="tab-button${tab === "mixer" ? " current" : ""}" data-action="practice-tab" data-tab="mixer" ${
    tab === "mixer" ? 'aria-current="page"' : ""
  }>${icon("mixer", 20)}Mixer</button>
      <button class="tab-button" data-action="panel" data-panel="export" aria-haspopup="dialog" aria-expanded="false">${
    icon("export", 20)
  }Export</button>
    </nav>
    <div class="panel-sheet-host">${exportPanel()}</div>
    <button class="panel-backdrop" data-action="panel-close" aria-label="Close panel" tabindex="-1" hidden></button>
    </div>
  `;
}
