import { setHtml } from "./dom";
import { chordIndexAt, type ChordNaming, nameChord } from "../analysis/chord-sheet";
import { KEY_UNCLEAR } from "../analysis/key";
import { keyName, transposeKey } from "../analysis/spelling";
import { playerTime } from "../player";
import { formatSemitones, projectSemitones } from "../practice";
import { cachedAnalysis } from "../tasks/analysis";
import type { AnalysisRecord, ChordSegment, MusicalKey, Project } from "../types";

/** Key and chord naming, and the chord playing now with the next ones. */

/** The key the song is in as far as the app knows: the user's, else a clear detected one. */
export function songKey(record: AnalysisRecord | null | undefined): MusicalKey | null {
  if (!record) return null;
  if (record.keyOverride) return record.keyOverride;
  return record.key && record.key.confidence >= KEY_UNCLEAR ? record.key : null;
}

/**
 * How the project's chords are named: as heard (with the key shift) unless
 * set to original; with a capo, as the shapes played with it (the chord
 * heard, transposed down by the capo).
 */
export function chordNaming(project: Project): ChordNaming {
  const record = cachedAnalysis(project.id);
  const capo = project.capo ?? 0;
  const semitones = capo
    ? projectSemitones(project) - capo
    : project.chordNames === "original"
    ? 0
    : projectSemitones(project);
  // Spelled for the key even when it is unclear: the best guess beats none.
  const key = record?.keyOverride ?? record?.key ?? null;
  return { key: key ? transposeKey(key, semitones) : null, semitones };
}

/** "A minor", or "A minor → B minor (+2)" with a key shift. */
export function keyText(key: MusicalKey, semitones: number): string {
  if (semitones === 0) return keyName(key);
  return `${keyName(key)} → ${keyName(transposeKey(key, semitones))} (${formatSemitones(semitones)})`;
}

/** Parses a key select value "tonic:mode". */
export function parseKey(value: string | undefined): MusicalKey | undefined {
  const [tonic, mode] = (value ?? "").split(":");
  if (mode !== "major" && mode !== "minor") return undefined;
  const pc = Number(tonic);
  return Number.isInteger(pc) && pc >= 0 && pc < 12 ? { tonic: pc, mode } : undefined;
}

/** "Now Am · Next F C G" in the toolbar. */
export function nowNextMarkup(): string {
  return `<div class="now-next" id="chord-now" aria-label="Current chord" hidden>
      <span class="muted">Now</span><strong class="chord-current" id="chord-current"></strong>
      <span class="muted next-label">Next</span><span class="chord-next" id="chord-next"></span>
    </div>`;
}

/** Shows the chord at the playhead and the next three (on ticks and while playing). */
export function updateChordNow(project: Project): void {
  const now = document.querySelector<HTMLElement>("#chord-now");
  if (!now) return;
  const chords = cachedAnalysis(project.id)?.chords ?? [];
  const show = chords.some((chord) => chord.root !== null);
  now.hidden = !show;
  if (!show) return;
  const naming = chordNaming(project);
  const index = chordIndexAt(chords, playerTime().position);
  const current = index >= 0 && chords[index].root !== null ? nameChord(chords[index], naming) : "—";
  setText("#chord-current", current);
  const next: string[] = [];
  let last = current;
  for (let i = index + 1; i < chords.length && next.length < 3; i++) {
    if (chords[i].root === null) continue;
    const name = nameChord(chords[i], naming);
    if (name !== last) next.push(name);
    last = name;
  }
  const html = next.map((name, i) => `<span class="next-${i}">${name}</span>`).join("");
  const holder = document.querySelector<HTMLElement>("#chord-next");
  if (holder) setHtml(holder, html);
}

/** The next sounding chord after `index` (skipping "no chord"). */
export function nextChord(chords: ChordSegment[], index: number): ChordSegment | null {
  for (let i = index + 1; i < chords.length; i++) {
    if (chords[i].root !== null) return chords[i];
  }
  return null;
}

function setText(selector: string, text: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element && element.textContent !== text) element.textContent = text;
}
