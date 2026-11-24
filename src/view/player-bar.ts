import { beatInBar } from "../analysis/chart";
import { playerTime } from "../player";
import { projectGrid } from "../tasks/analysis";
import type { Project } from "../types";
import { currentBar } from "./chart";
import { formatTime } from "./format";
import { icon } from "./icons";
import { rhythmPanel } from "./panels";

/**
 * The player: a seek bar with the loop on it, the time and the bar playing,
 * and the transport (loop, previous bar, play, next bar, click). The click
 * button toggles the click; the button beside it (or a long press on a
 * phone) opens Rhythm.
 */

export function playerMarkup(project: Project): string {
  const time = playerTime();
  return `
    <footer class="player" aria-label="Player">
      <div class="scrub-row">
        <span id="current-time" class="time">${formatTime(time.position)}</span>
        <div class="scrub">
          <div class="scrub-track" aria-hidden="true"><span class="scrub-loop" hidden></span><span class="scrub-fill"></span></div>
          <input id="seek-bar" type="range" min="0" step="any" max="${time.duration}" value="${time.position}" ${
    time.duration ? "" : "disabled"
  } aria-label="Seek" />
        </div>
        <span id="total-time" class="time muted">${formatTime(time.duration)}</span>
      </div>
      <div class="transport-row">
        <div class="player-where"><strong id="section-label"></strong><span id="bar-label" class="muted"></span></div>
        <div class="transport">
          <button class="round-button loop-button" data-action="loop-toggle" aria-label="Loop" aria-pressed="false">${icon("loop", 20)}</button>
          <button class="round-button" data-action="bar-step" data-step="-1" aria-label="Previous bar">${icon("prev", 20)}</button>
          <button class="play-button" data-action="play" aria-label="${playLabel(time)}" ${time.ready ? "" : "disabled"}>${
    playGlyph(time)
  }</button>
          <button class="round-button" data-action="bar-step" data-step="1" aria-label="Next bar">${icon("next", 20)}</button>
          <div class="click-split popover-anchor up">
            <button class="round-button click-button" data-action="click-button" aria-pressed="${
    project.clickOn === true
  }" aria-label="Click track" title="Click on or off (long-press for rhythm settings)">${icon("metronome", 20)}</button>
            <button class="click-more" data-action="panel" data-panel="rhythm" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel-rhythm" aria-label="Rhythm settings">${
    icon("chevronDown", 16)
  }</button>
            ${rhythmPanel(project)}
          </div>
        </div>
        <div class="player-side"></div>
      </div>
    </footer>`;
}

/** Updates the seek bar, times, bar label and play button (on every tick). */
export function updatePlayerDisplay(project?: Project | null): void {
  const range = document.querySelector<HTMLInputElement>("#seek-bar");
  const play = document.querySelector<HTMLButtonElement>('[data-action="play"]');
  if (!range || !play) return;
  const time = playerTime();
  range.max = String(time.duration);
  if (document.activeElement !== range) range.value = String(time.position);
  range.disabled = !time.duration;
  setText("#current-time", formatTime(time.position));
  setText("#total-time", formatTime(time.duration));
  const glyph = playGlyph(time);
  if (play.innerHTML !== glyph) play.innerHTML = glyph;
  play.setAttribute("aria-label", playLabel(time));
  play.disabled = !time.ready;
  const fill = document.querySelector<HTMLElement>(".scrub-fill");
  if (fill) fill.style.width = `${time.duration ? (time.position / time.duration) * 100 : 0}%`;
  if (project) {
    const grid = projectGrid(project.id);
    const bar = currentBar();
    let section = "";
    if (bar) for (const marker of project.markers ?? []) if (marker.bar <= bar.number) section = marker.name;
    setText("#section-label", section);
    setText("#bar-label", grid && bar ? `Bar ${bar.number} · beat ${beatInBar(grid, time.position) + 1}` : "");
  }
}

/** Shows the loop on the seek bar. */
export function updateScrubLoop(project: Project): void {
  const region = document.querySelector<HTMLElement>(".scrub-loop");
  const { duration } = playerTime();
  if (!region) return;
  const loop = project.loop;
  region.hidden = !loop || !(duration > 0);
  if (region.hidden) return;
  region.classList.toggle("off", !loop!.enabled);
  region.style.left = `${(loop!.start / duration) * 100}%`;
  region.style.width = `${((loop!.end - loop!.start) / duration) * 100}%`;
}

function playGlyph(time: ReturnType<typeof playerTime>): string {
  if (!time.ready) return `<span class="loading-dots" aria-hidden="true">…</span>`;
  return time.playing ? icon("pause", 24) : icon("play", 24);
}

function playLabel(time: ReturnType<typeof playerTime>): string {
  if (!time.ready) return "Loading stems";
  return time.playing ? "Pause" : "Play";
}

function setText(selector: string, text: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element && element.textContent !== text) element.textContent = text;
}
