import { activeMixPreset, MIX_PRESETS } from "../mix-presets";
import { icon } from "./icons";
import { soloStems, stemVolume } from "../mixing";
import { projectGrid } from "../tasks/analysis";
import {
  ALL_STEMS,
  DEFAULT_CLICK_VOLUME,
  MODEL_STEMS,
  type Project,
  projectModel,
  stemLevel,
  type Track,
  TRACK_LABELS,
} from "../types";

/**
 * The mixer: presets, then a row per stem (volume, mute, solo) and, once
 * the beats are known, the click. The click's M is the same on/off as the
 * click button in the player and the switch in Rhythm.
 */

export function mixerMarkup(project: Project): string {
  const model = projectModel(project);
  return `
    <aside class="mixer-panel" id="mixer" aria-label="Mixer">
      <div class="mixer-head">
        <h2>Mixer</h2>
        <span class="muted">${MODEL_STEMS[model].length} stems · ${model === "htdemucs-6s" ? "Demucs" : "Spleeter"}</span>
        <button class="icon-button tablet-only mixer-close" data-action="mixer-toggle" aria-label="Close the mixer">${icon("close", 18)}</button>
      </div>
      <div class="mix-presets" role="group" aria-label="Mix presets">${
    MIX_PRESETS.map((preset) =>
      `<button class="chip" data-action="mix-preset" data-preset="${preset.id}" aria-pressed="false">${preset.label}</button>`
    ).join("")
  }</div>
      <div class="stem-rows">${stemRowsMarkup(project)}</div>
    </aside>`;
}

/** The stem rows, and the click's once the beats are known. */
export function stemRowsMarkup(project: Project): string {
  const stems = ALL_STEMS.filter((stem) => project.completedStems.includes(stem));
  return stems.map((stem) => rowMarkup(project, stem)).join("") +
    (projectGrid(project.id) ? rowMarkup(project, "click") : "");
}

function rowMarkup(project: Project, track: Track): string {
  const label = TRACK_LABELS[track];
  const volume = track === "click" ? project.clickVolume ?? DEFAULT_CLICK_VOLUME : stemLevel(project, track);
  return `
        <div class="stem-row stem-${track}" data-stem-row="${track}" role="group" aria-label="${label}">
          <div class="stem-row-head">
            <span class="stem-dot" aria-hidden="true"></span>
            <span class="stem-name">${label}</span>
            <span class="slider-value" data-volume-label="${track}">${Math.round(volume * 100)}%</span>
            <button class="ms-button" data-action="mute" data-stem="${track}" aria-pressed="false" aria-label="Mute ${label}">M</button>
            <button class="ms-button solo" data-action="solo" data-stem="${track}" aria-pressed="false" aria-label="Solo ${label}">S</button>
          </div>
          <input type="range" min="0" max="1" step="0.01" value="${volume}" data-action="volume" data-stem="${track}" aria-label="${label} volume" />
        </div>`;
}

/** Updates mutes, solos, volumes and the preset chips, in place. */
export function updateMixer(project: Project): void {
  const solos = soloStems(project);
  for (const row of document.querySelectorAll<HTMLElement>("[data-stem-row]")) {
    const track = row.dataset.stemRow as Track;
    // The click is "muted" while it is off.
    const muted = track === "click" ? project.clickOn !== true : project.mutedStems.includes(track as never);
    const soloed = solos.includes(track);
    const mute = row.querySelector<HTMLButtonElement>('[data-action="mute"]');
    const solo = row.querySelector<HTMLButtonElement>('[data-action="solo"]');
    mute?.setAttribute("aria-pressed", String(muted));
    mute?.classList.toggle("on", muted);
    if (mute) {
      mute.setAttribute("aria-label", `${muted ? "Unmute" : "Mute"} ${TRACK_LABELS[track]}`);
    }
    solo?.setAttribute("aria-pressed", String(soloed));
    solo?.classList.toggle("on", soloed);
    row.classList.toggle("silent", stemVolume(project, track) === 0);
  }
  // Every volume slider of a track (the click has two: here and in Rhythm).
  for (const slider of document.querySelectorAll<HTMLInputElement>('input[data-action="volume"]')) {
    const track = slider.dataset.stem as Track;
    const volume = track === "click" ? project.clickVolume ?? DEFAULT_CLICK_VOLUME : stemLevel(project, track);
    if (document.activeElement !== slider) slider.value = String(volume);
    slider.disabled = track === "click" ? project.clickOn !== true : project.mutedStems.includes(track as never);
  }
  for (const label of document.querySelectorAll<HTMLElement>("[data-volume-label]")) {
    const track = label.dataset.volumeLabel as Track;
    const volume = track === "click" ? project.clickVolume ?? DEFAULT_CLICK_VOLUME : stemLevel(project, track);
    label.textContent = `${Math.round(volume * 100)}%`;
  }
  const preset = activeMixPreset(project);
  for (const chip of document.querySelectorAll<HTMLElement>('[data-action="mix-preset"]')) {
    const on = chip.dataset.preset === preset?.id;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  for (const button of document.querySelectorAll<HTMLElement>('[data-action="click-button"]')) {
    button.setAttribute("aria-pressed", String(project.clickOn === true));
    button.classList.toggle("on", project.clickOn === true);
  }
}
