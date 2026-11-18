import { playerTime } from "../player";
import {
  formatPrecise,
  formatSemitones,
  formatSpeed,
  isNeutral,
  MAX_SEMITONES,
  MAX_SPEED,
  MIN_SEMITONES,
  MIN_SPEED,
  projectSemitones,
  projectSpeed,
} from "../practice";
import { projectGrid } from "../tasks/analysis";
import type { Project } from "../types";
import { tempoChipMarkup, tempoPanelMarkup, updateTempoDisplay } from "./tempo";

/**
 * The practice bar (speed, key, loop) and the loop ruler above the stems.
 * Changes update these in place rather than re-rendering the page, so a
 * slider being dragged or a focused button keeps working.
 */

export function practiceMarkup(project: Project): string {
  const speed = projectSpeed(project);
  const semitones = projectSemitones(project);
  const loop = project.loop;
  return `
    <div class="practice-bar">
      <div class="practice-group speed-group" role="group" aria-label="Speed">
        <span class="practice-label">Speed</span>
        <button class="step-button" data-action="speed-step" data-step="-1" aria-label="Slower (−5%)" ${
    speed <= MIN_SPEED ? "disabled" : ""
  }>−</button>
        <input id="speed" type="range" min="${MIN_SPEED * 100}" max="${
    MAX_SPEED * 100
  }" step="1" value="${Math.round(speed * 100)}" data-action="speed" aria-label="Speed" aria-valuetext="${
    formatSpeed(speed)
  }" />
        <button class="step-button" data-action="speed-step" data-step="1" aria-label="Faster (+5%)" ${
    speed >= MAX_SPEED ? "disabled" : ""
  }>+</button>
        <output id="speed-value" class="practice-value">${formatSpeed(speed)}</output>
      </div>
      <div class="practice-group key-group" role="group" aria-label="Key">
        <span class="practice-label">Key</span>
        <button class="step-button" data-action="key-step" data-step="-1" aria-label="Key down a semitone" ${
    semitones <= MIN_SEMITONES ? "disabled" : ""
  }>−</button>
        <output id="key-value" class="practice-value" aria-live="polite">${
    formatSemitones(semitones)
  }</output>
        <button class="step-button" data-action="key-step" data-step="1" aria-label="Key up a semitone" ${
    semitones >= MAX_SEMITONES ? "disabled" : ""
  }>+</button>
      </div>
      <div class="practice-group loop-group" role="group" aria-label="Loop">
        <span class="practice-label">Loop</span>
        <button class="step-button" data-action="loop-set" data-edge="start" aria-label="Set loop start at the playhead ([)">A</button>
        <button class="step-button" data-action="loop-set" data-edge="end" aria-label="Set loop end at the playhead (])">B</button>
        <button class="loop-toggle${loop?.enabled ? " on" : ""}" data-action="loop-toggle" aria-pressed="${
    loop?.enabled ?? false
  }" ${loop ? "" : "disabled"}>Loop</button>
        <output id="loop-value" class="practice-value">${loopText(project)}</output>
        <button class="step-button" data-action="loop-clear" aria-label="Clear loop" ${
    loop ? "" : "hidden"
  }>×</button>
      </div>
      <div class="practice-group bars-group" role="group" aria-label="Loop bars from the playhead">
        <span class="practice-label">Bars</span>
        ${
    [1, 2, 4].map((bars) =>
      `<button class="step-button" data-action="loop-bars" data-bars="${bars}" aria-label="Loop ${bars} bar${
        bars > 1 ? "s" : ""
      } from the playhead${bars === 1 ? " (B)" : ""}" ${projectGrid(project.id) ? "" : "disabled"}>${bars}</button>`
    ).join("")
  }
      </div>
      ${tempoChipMarkup()}
      <button class="button text-button practice-reset" data-action="practice-reset" ${
    isNeutral(project) ? "hidden" : ""
  }>Reset</button>
    </div>
    ${tempoPanelMarkup()}
  `;
}

/** The strip above the stems where a loop is drawn, dragged and adjusted. */
export function loopRulerMarkup(): string {
  return `
    <div class="loop-ruler" data-action="waveform-seek" title="Drag to set a loop">
      <canvas class="grid-canvas"></canvas>
      <span class="loop-band" hidden></span>
      <span class="playhead"></span>
      <span class="loop-handle" data-loop-handle="start" role="slider" tabindex="0" aria-label="Loop start" hidden></span>
      <span class="loop-handle" data-loop-handle="end" role="slider" tabindex="0" aria-label="Loop end" hidden></span>
    </div>
  `;
}

/** Updates the practice bar and loop display for `project`, in place. */
export function updatePracticeDisplay(project: Project): void {
  const speed = projectSpeed(project);
  const semitones = projectSemitones(project);
  const slider = document.querySelector<HTMLInputElement>("#speed");
  if (slider) {
    const value = String(Math.round(speed * 100));
    if (slider.value !== value) slider.value = value;
    slider.setAttribute("aria-valuetext", formatSpeed(speed));
  }
  setText("#speed-value", formatSpeed(speed));
  setText("#key-value", formatSemitones(semitones));
  setDisabled('[data-action="speed-step"][data-step="-1"]', speed <= MIN_SPEED);
  setDisabled('[data-action="speed-step"][data-step="1"]', speed >= MAX_SPEED);
  setDisabled('[data-action="key-step"][data-step="-1"]', semitones <= MIN_SEMITONES);
  setDisabled('[data-action="key-step"][data-step="1"]', semitones >= MAX_SEMITONES);
  const toggle = document.querySelector<HTMLButtonElement>('[data-action="loop-toggle"]');
  if (toggle) {
    toggle.disabled = !project.loop;
    toggle.classList.toggle("on", project.loop?.enabled ?? false);
    toggle.setAttribute("aria-pressed", String(project.loop?.enabled ?? false));
  }
  setText("#loop-value", loopText(project));
  setHidden('[data-action="loop-clear"]', !project.loop);
  setHidden('[data-action="practice-reset"]', isNeutral(project));
  setHidden(".export-practice", isNeutral(project));
  const grid = projectGrid(project.id);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="loop-bars"]')) {
    button.disabled = !grid;
  }
  updateTempoDisplay(project);
  updateLoopDisplay(project);
}

/** Positions the loop band and handles (also after the player loads). */
export function updateLoopDisplay(project: Project | null): void {
  const { duration } = playerTime();
  const loop = project?.loop;
  const show = Boolean(loop && duration > 0);
  const left = show ? (loop!.start / duration) * 100 : 0;
  const right = show ? (loop!.end / duration) * 100 : 0;
  for (const band of document.querySelectorAll<HTMLElement>(".loop-band")) {
    band.hidden = !show;
    band.classList.toggle("off", !loop?.enabled);
    band.style.left = `${left}%`;
    band.style.width = `${right - left}%`;
  }
  for (const handle of document.querySelectorAll<HTMLElement>("[data-loop-handle]")) {
    handle.hidden = !show;
    if (!show) continue;
    const edge = handle.dataset.loopHandle === "start" ? loop!.start : loop!.end;
    handle.style.left = `${(edge / duration) * 100}%`;
    handle.setAttribute("aria-valuemin", "0");
    handle.setAttribute("aria-valuemax", String(duration));
    handle.setAttribute("aria-valuenow", String(edge));
    handle.setAttribute("aria-valuetext", formatPrecise(edge));
  }
}

function loopText(project: Project): string {
  const loop = project.loop;
  return loop ? `${formatPrecise(loop.start)}–${formatPrecise(loop.end)}` : "Off";
}

function setText(selector: string, text: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element && element.textContent !== text) element.textContent = text;
}

function setDisabled(selector: string, disabled: boolean): void {
  const element = document.querySelector<HTMLButtonElement>(selector);
  if (element) element.disabled = disabled;
}

function setHidden(selector: string, hidden: boolean): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element) element.hidden = hidden;
}
