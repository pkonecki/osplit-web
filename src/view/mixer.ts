import { exportFormat } from "../export";
import { playerTime } from "../player";
import { type Project, STEM_LABELS, STEMS } from "../types";
import { formatTime } from "./format";

export function renderMixer(project: Project): string {
  const time = playerTime();
  const format = exportFormat();
  return `
    <section class="mixer-card">
      <div class="mixer-title">
        <h2>Project player &amp; mixer</h2>
        <div class="export-actions">
          <select class="export-format" data-action="export-format" aria-label="Export format">
            <option value="flac" ${format === "flac" ? "selected" : ""}>FLAC · smaller, lossless</option>
            <option value="wav" ${format === "wav" ? "selected" : ""}>WAV · most compatible</option>
          </select>
          <button class="button outline" data-action="export-mix">Export full mix</button>
        </div>
      </div>
      <div class="player-row">
        <button class="play-button" data-action="play" aria-label="${
    playLabel(time)
  }" ${time.ready ? "" : "disabled"}>${playGlyph(time)}</button>
        <div class="seek-area">
          <input id="seek-bar" type="range" min="0" step="any" max="${time.duration}" value="${time.position}" ${
    time.duration ? "" : "disabled"
  } aria-label="Seek" />
          <div class="time-row"><span id="current-time">${
    formatTime(time.position)
  }</span><span id="total-time">${formatTime(time.duration)}</span></div>
        </div>
      </div>
      <div class="stem-list">
        ${
    STEMS.filter((stem) => project.completedStems.includes(stem)).map((
      stem,
    ) => `
          <div class="stem-control">
            <span class="stem-label">${STEM_LABELS[stem]}</span>
            <input type="range" min="0" max="1" step="0.01" value="${
      project.volumes[stem]
    }" data-action="volume" data-stem="${stem}" aria-label="${
      STEM_LABELS[stem]
    } volume" ${project.mutedStems.includes(stem) ? "disabled" : ""} />
            <button class="mute-button ${
      project.mutedStems.includes(stem) ? "muted" : ""
    }" data-action="mute" data-stem="${stem}" aria-label="${
      project.mutedStems.includes(stem) ? "Unmute" : "Mute"
    } ${STEM_LABELS[stem]}">${
      project.mutedStems.includes(stem) ? "◖×" : "◖))"
    }</button>
            <button class="button text-button" data-action="export-stem" data-stem="${stem}">Export</button>
          </div>
        `).join("")
  }
      </div>
    </section>
  `;
}

export function updatePlayerDisplay(): void {
  const range = document.querySelector<HTMLInputElement>("#seek-bar");
  const current = document.querySelector<HTMLElement>("#current-time");
  const total = document.querySelector<HTMLElement>("#total-time");
  const play = document.querySelector<HTMLButtonElement>(
    '[data-action="play"]',
  );
  if (!range || !current || !total || !play) return;
  const time = playerTime();
  range.max = String(time.duration);
  if (document.activeElement !== range) range.value = String(time.position);
  range.disabled = !time.duration;
  current.textContent = formatTime(time.position);
  total.textContent = formatTime(time.duration);
  play.textContent = playGlyph(time);
  play.setAttribute("aria-label", playLabel(time));
  play.disabled = !time.ready;
}

function playGlyph(time: ReturnType<typeof playerTime>): string {
  if (!time.ready) return "…";
  return time.playing ? "Ⅱ" : "▶";
}

function playLabel(time: ReturnType<typeof playerTime>): string {
  if (!time.ready) return "Loading stems";
  return time.playing ? "Pause" : "Play";
}
