import { exportAppliesPractice, exportFormat } from "../export";
import { isNeutral } from "../practice";
import { soloStems, stemVolume } from "../mixing";
import { playerTime } from "../player";
import { projectGrid } from "../tasks/analysis";
import { DEFAULT_CLICK_VOLUME, type Project, STEM_LABELS, STEMS } from "../types";
import { formatTime } from "./format";
import { chordLaneMarkup, chordNowMarkup } from "./harmony";
import { loopRulerMarkup, practiceMarkup } from "./practice";
import { updatePlayheads, waveformMarkup } from "./waveforms";

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
          <label class="check-row export-practice" ${
    isNeutral(project) ? "hidden" : ""
  }><input type="checkbox" data-action="export-practice" ${
    exportAppliesPractice() ? "checked" : ""
  } /> Mix with speed, key &amp; loop</label>
          <button class="button outline" data-action="export-mix">Export full mix</button>
          <button class="button outline" data-action="export-all">Export all (zip)</button>
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
      ${practiceMarkup(project)}
      ${chordNowMarkup()}
      ${loopRulerMarkup()}
      ${chordLaneMarkup()}
      <div class="stem-list">
        ${
    STEMS.filter((stem) => project.completedStems.includes(stem)).map((
      stem,
    ) => `
          <div class="stem-control" tabindex="0" data-stem-row="${stem}" aria-label="${
      STEM_LABELS[stem]
    } (M to mute, S to solo)">
            <span class="stem-label">${STEM_LABELS[stem]}</span>
            <input type="range" min="0" max="1" step="0.01" value="${
      project.volumes[stem]
    }" data-action="volume" data-stem="${stem}" aria-label="${
      STEM_LABELS[stem]
    } volume" ${project.mutedStems.includes(stem) ? "disabled" : ""} />
            <button class="solo-button ${
      soloStems(project).includes(stem) ? "soloed" : ""
    }" data-action="solo" data-stem="${stem}" aria-pressed="${
      soloStems(project).includes(stem)
    }" aria-label="Solo ${STEM_LABELS[stem]}">S</button>
            <button class="mute-button ${
      project.mutedStems.includes(stem) ? "muted" : ""
    }" data-action="mute" data-stem="${stem}" aria-label="${
      project.mutedStems.includes(stem) ? "Unmute" : "Mute"
    } ${STEM_LABELS[stem]}">${
      project.mutedStems.includes(stem) ? "◖×" : "◖))"
    }</button>
            <button class="button text-button" data-action="export-stem" data-stem="${stem}">Export</button>
            ${waveformMarkup(stem, stemVolume(project, stem) === 0)}
          </div>
        `).join("")
  }
        ${projectGrid(project.id) ? clickRowMarkup(project) : ""}
      </div>
    </section>
  `;
}

/** The click track's mixer row: muted (off) until turned on. */
function clickRowMarkup(project: Project): string {
  const on = project.clickOn === true;
  const soloed = soloStems(project).includes("click");
  return `
          <div class="stem-control click-row" tabindex="0" data-stem-row="click" aria-label="Click (C or M to turn on or off, S to solo)">
            <span class="stem-label">Click</span>
            <input type="range" min="0" max="1" step="0.01" value="${
    project.clickVolume ?? DEFAULT_CLICK_VOLUME
  }" data-action="volume" data-stem="click" aria-label="Click volume" ${on ? "" : "disabled"} />
            <button class="solo-button ${soloed ? "soloed" : ""}" data-action="solo" data-stem="click" aria-pressed="${soloed}" aria-label="Solo Click">S</button>
            <button class="mute-button ${on ? "" : "muted"}" data-action="mute" data-stem="click" aria-label="${
    on ? "Mute" : "Unmute"
  } Click">${on ? "◖))" : "◖×"}</button>
            <button class="button text-button" data-action="export-stem" data-stem="click">Export</button>
            ${waveformMarkup("click", stemVolume(project, "click") === 0)}
          </div>
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
  updatePlayheads();
}

function playGlyph(time: ReturnType<typeof playerTime>): string {
  if (!time.ready) return "…";
  return time.playing ? "Ⅱ" : "▶";
}

function playLabel(time: ReturnType<typeof playerTime>): string {
  if (!time.ready) return "Loading stems";
  return time.playing ? "Pause" : "Play";
}
