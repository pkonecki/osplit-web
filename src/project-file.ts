import { AUDIO_MIME, detectAudioFormat } from "./audio-format";
import { clampSemitones, clampSpeed } from "./practice";
import type { ProjectData } from "./storage";
import {
  ALL_STEMS,
  type AnalysisRecord,
  type ChordSegment,
  type GridEdits,
  type KeyEstimate,
  MODEL_IDS,
  MODEL_STEMS,
  type Modulation,
  type MusicalKey,
  newProject,
  type Project,
  type ProjectLoop,
  projectModel,
  type Stem,
  type Track,
} from "./types";
import { safeFileName } from "./view/format";
import { crc32OfBlob, createZip, readZip, type ZipEntry } from "./zip";

/**
 * Project files (`.osplit`): one project with its source audio, stems,
 * waveforms and analysis, to move it to another device or keep a backup.
 *
 * The file is a ZIP archive, stored uncompressed (audio barely compresses):
 *
 *   osplit.json          manifest: format, version, project, analysis
 *   source/<name>        the source audio, when it was kept
 *   stems/<stem>.flac    each separated stem (.wav for older projects); which
 *                        stems depends on the project's model
 *   peaks/<stem>.f32     waveform overviews, little-endian float32
 *   analysis/beats.f32   beat times, little-endian float32
 *
 * Models are not included: they are downloaded again where needed. Files
 * are read without trusting them: every value is checked, and a part that
 * doesn't check out is dropped (the analysis, a waveform) or rejected.
 */

export const PROJECT_FILE_EXTENSION = ".osplit";
export const PROJECT_FILE_TYPE = "application/x-osplit";
const FORMAT = "osplit-project";
/** Bumped when a change would be misread by older versions of the app. */
export const PROJECT_FILE_VERSION = 1;
const MANIFEST = "osplit.json";
const BEATS = "analysis/beats.f32";

interface Manifest {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  project: Project;
  /** The source audio's archive path and original name. */
  source?: { file: string; name: string; type?: string };
  stems: Partial<Record<Stem, string>>;
  peaks: Partial<Record<Stem, string>>;
  /** The analysis, with its beat times in BEATS. */
  analysis?: Omit<AnalysisRecord, "beats" | "projectId">;
}

export function isProjectFile(file: { name: string }): boolean {
  return file.name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION);
}

export function projectFileName(project: Project): string {
  return `${safeFileName(project.name)}${PROJECT_FILE_EXTENSION}`;
}

function floatsToBlob(values: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return new Blob([view.buffer]);
}

async function blobToFloats(blob: Blob): Promise<Float32Array | null> {
  if (blob.size % 4 !== 0) return null;
  const view = new DataView(await blob.arrayBuffer());
  const values = new Float32Array(blob.size / 4);
  for (let i = 0; i < values.length; i++) {
    values[i] = view.getFloat32(i * 4, true);
    if (!Number.isFinite(values[i])) return null;
  }
  return values;
}

/** Builds the project file of a project's stored data. */
export async function createProjectFile(data: ProjectData): Promise<Blob> {
  const entries: ZipEntry[] = [];
  const manifest: Manifest = {
    format: FORMAT,
    version: PROJECT_FILE_VERSION,
    exportedAt: Date.now(),
    project: data.project,
    stems: {},
    peaks: {},
  };
  if (data.source) {
    const file = `source/${safeFileName(data.source.name)}`;
    manifest.source = { file, name: data.source.name, type: data.source.blob.type };
    entries.push({ name: file, data: data.source.blob });
  }
  for (const stem of ALL_STEMS) {
    const blob = data.stems[stem];
    if (blob) {
      const file = `stems/${stem}.${await detectAudioFormat(blob)}`;
      manifest.stems[stem] = file;
      entries.push({ name: file, data: blob });
    }
    const peaks = data.peaks[stem];
    if (peaks) {
      const file = `peaks/${stem}.f32`;
      manifest.peaks[stem] = file;
      entries.push({ name: file, data: floatsToBlob(peaks) });
    }
  }
  if (data.analysis) {
    const { beats, projectId: _, ...rest } = data.analysis;
    manifest.analysis = rest;
    entries.push({ name: BEATS, data: floatsToBlob(beats) });
  }
  entries.unshift({ name: MANIFEST, data: new Blob([JSON.stringify(manifest, null, 2)]) });
  const zip = await createZip(entries);
  return new Blob([zip], { type: PROJECT_FILE_TYPE });
}

const NOT_A_PROJECT =
  "That file isn't an OSplit project. Choose a .osplit file exported from OSplit.";
const DAMAGED = "The project file is damaged. Export it again on the other device.";

/**
 * Reads a project file into project data ready to store. The project keeps
 * the id it had, so an import can tell when it is already on this device.
 */
export async function readProjectFile(file: Blob): Promise<ProjectData> {
  let entries;
  try {
    entries = new Map((await readZip(file)).map((entry) => [entry.name, entry]));
  } catch {
    throw new Error(NOT_A_PROJECT);
  }
  const manifestEntry = entries.get(MANIFEST);
  if (!manifestEntry) throw new Error(NOT_A_PROJECT);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await manifestEntry.data.text());
  } catch {
    throw new Error(DAMAGED);
  }
  if (!isRecord(manifest) || manifest.format !== FORMAT) throw new Error(NOT_A_PROJECT);
  if (typeof manifest.version !== "number" || manifest.version > PROJECT_FILE_VERSION) {
    throw new Error(
      "This project was exported by a newer version of OSplit. Update OSplit (reload the page) to import it.",
    );
  }

  /** The data at an archive path the manifest names, checked against its CRC. */
  const checked = async (path: unknown): Promise<Blob | undefined> => {
    if (typeof path !== "string") return undefined;
    const entry = entries.get(path);
    if (!entry) throw new Error(DAMAGED);
    if (await crc32OfBlob(entry.data) !== entry.crc) throw new Error(DAMAGED);
    return entry.data;
  };

  const project = readProject(manifest.project);
  const stems: Partial<Record<Stem, Blob>> = {};
  const peaks: Partial<Record<Stem, Float32Array>> = {};
  const stemPaths = isRecord(manifest.stems) ? manifest.stems : {};
  const peakPaths = isRecord(manifest.peaks) ? manifest.peaks : {};
  // The model decides which stems a finished separation has.
  const expected = MODEL_STEMS[projectModel(project)];
  for (const stem of expected) {
    const blob = await checked(stemPaths[stem]);
    if (blob) {
      let format;
      try {
        format = await detectAudioFormat(blob);
      } catch {
        throw new Error(DAMAGED);
      }
      stems[stem] = new Blob([blob], { type: AUDIO_MIME[format] });
    }
    const peakData = await checked(peakPaths[stem]);
    const values = peakData && await blobToFloats(peakData);
    if (values && stems[stem]) peaks[stem] = values;
  }
  // Stems come as the model's full set: a partial set is a separation that
  // didn't finish.
  const complete = expected.every((stem) => stems[stem]);
  project.completedStems = complete ? [...expected] : [];

  let source: ProjectData["source"];
  if (isRecord(manifest.source) && typeof manifest.source.name === "string") {
    const blob = await checked(manifest.source.file);
    if (blob) {
      const name = manifest.source.name.slice(0, 255) || "source";
      const type = typeof manifest.source.type === "string" &&
          /^audio\/[\w.+-]+$/.test(manifest.source.type)
        ? manifest.source.type
        : "";
      source = { id: project.id, blob: new Blob([blob], { type }), name };
      project.sourceName = name;
    }
  }
  project.sourceRemoved = !source && project.sourceName !== null && complete;
  if (!source && !complete) project.sourceName = null;

  if (!source && !complete) {
    project.status = "empty";
  } else if (complete) {
    project.status = "ready";
  } else if (project.status === "processing" || project.status === "empty") {
    project.status = project.status === "processing" ? "interrupted" : "ready";
  }
  if (project.status === "ready" || project.status === "empty") {
    project.errorMessage = null;
  } else {
    project.errorMessage ??= "The separation didn't finish before the export. Start it again to retry.";
  }
  project.taskProgress = complete ? 100 : 0;
  project.taskStage = "";

  let analysis: AnalysisRecord | undefined;
  if (complete && manifest.analysis) {
    const beats = await checked(BEATS);
    const values = beats && await blobToFloats(beats);
    analysis = values ? readAnalysis(manifest.analysis, project.id, values) : undefined;
  }
  return { project, source, stems: complete ? stems : {}, peaks, analysis };
}

/** A copy of imported data under a new id, to keep both projects. */
export function asCopy(data: ProjectData): ProjectData {
  const id = crypto.randomUUID();
  return {
    ...data,
    project: { ...data.project, id, name: `${data.project.name} (copy)`.slice(0, 80) },
    source: data.source && { ...data.source, id },
    analysis: data.analysis && { ...data.analysis, projectId: id },
  };
}

// --- Checking values read from a file ---------------------------------------

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unit(value: unknown, fallback: number): number {
  return isNumber(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function tracks<T extends Track>(value: unknown, allowed: readonly T[]): T[] {
  return Array.isArray(value) ? allowed.filter((track) => value.includes(track)) : [];
}

const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;

function readProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error(DAMAGED);
  const name = typeof value.name === "string" ? value.name.slice(0, 80) : "";
  const project = newProject(name || "Imported project");
  if (typeof value.id === "string" && PROJECT_ID.test(value.id)) project.id = value.id;
  if (isNumber(value.createdAt)) project.createdAt = value.createdAt;
  if (typeof value.sourceName === "string") project.sourceName = value.sourceName.slice(0, 255);
  if (["empty", "ready", "processing", "interrupted", "failed"].includes(value.status)) {
    project.status = value.status;
  }
  if (MODEL_IDS.includes(value.model)) project.model = value.model;
  if (value.quality === "fp32") project.quality = "fp32";
  if (isRecord(value.volumes)) {
    // A stem with no volume plays at full volume.
    for (const stem of ALL_STEMS) {
      if (value.volumes[stem] !== undefined) project.volumes[stem] = unit(value.volumes[stem], 1);
    }
  }
  project.mutedStems = tracks(value.mutedStems, ALL_STEMS);
  project.soloStems = tracks<Track>(value.soloStems, [...ALL_STEMS, "click"]);
  if (value.clickVolume !== undefined) project.clickVolume = unit(value.clickVolume, 0.8);
  if (typeof value.clickOn === "boolean") project.clickOn = value.clickOn;
  if (value.deleteSourceAfterSeparation === true) project.deleteSourceAfterSeparation = true;
  if (isNumber(value.speed)) project.speed = clampSpeed(value.speed);
  if (isNumber(value.semitones)) project.semitones = clampSemitones(value.semitones);
  const loop = value.loop;
  if (
    isRecord(loop) && isNumber(loop.start) && isNumber(loop.end) &&
    loop.start >= 0 && loop.end > loop.start
  ) {
    project.loop = { start: loop.start, end: loop.end, enabled: loop.enabled === true } satisfies ProjectLoop;
  }
  if (value.chordNames === "original" || value.chordNames === "transposed") {
    project.chordNames = value.chordNames;
  }
  if (typeof value.errorMessage === "string") project.errorMessage = value.errorMessage.slice(0, 500);
  return project;
}

function pitchClass(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < 12;
}

function readKey(value: unknown): MusicalKey | undefined {
  return isRecord(value) && pitchClass(value.tonic) &&
      (value.mode === "major" || value.mode === "minor")
    ? { tonic: value.tonic, mode: value.mode }
    : undefined;
}

function readEdits(value: unknown): GridEdits | undefined {
  if (!isRecord(value)) return undefined;
  const edits: GridEdits = {};
  if (isNumber(value.bpmFactor) && value.bpmFactor > 0) edits.bpmFactor = value.bpmFactor;
  if (Number.isInteger(value.downbeatShift)) edits.downbeatShift = value.downbeatShift;
  if (value.beatsPerBar === 3 || value.beatsPerBar === 4) edits.beatsPerBar = value.beatsPerBar;
  if (
    isRecord(value.tapped) && isNumber(value.tapped.bpm) && value.tapped.bpm > 0 &&
    isNumber(value.tapped.anchor)
  ) {
    edits.tapped = { bpm: value.tapped.bpm, anchor: value.tapped.anchor };
  }
  return edits;
}

/** The analysis, or undefined if any part is malformed (it is redone then). */
function readAnalysis(
  value: Record<string, any>,
  projectId: string,
  beats: Float32Array,
): AnalysisRecord | undefined {
  if (
    !isNumber(value.algorithmVersion) || !isNumber(value.duration) ||
    !isNumber(value.bpm) || !isNumber(value.bpmConfidence) ||
    !(value.alternativeBpm === null || isNumber(value.alternativeBpm)) ||
    (value.source !== "drums" && value.source !== "mix") ||
    (value.beatsPerBar !== 3 && value.beatsPerBar !== 4) ||
    !Number.isInteger(value.firstDownbeatIndex)
  ) return undefined;
  const record: AnalysisRecord = {
    projectId,
    algorithmVersion: value.algorithmVersion,
    source: value.source,
    duration: value.duration,
    bpm: value.bpm,
    bpmConfidence: value.bpmConfidence,
    alternativeBpm: value.alternativeBpm,
    beats,
    beatsPerBar: value.beatsPerBar,
    firstDownbeatIndex: value.firstDownbeatIndex,
  };
  if (value.edits !== undefined) {
    const edits = readEdits(value.edits);
    if (!edits) return undefined;
    record.edits = edits;
  }
  if (value.tuningCents !== undefined) {
    if (!isNumber(value.tuningCents)) return undefined;
    record.tuningCents = value.tuningCents;
  }
  if (value.key !== undefined) {
    if (value.key === null) {
      record.key = null;
    } else {
      const key = readKey(value.key);
      const alternative = isRecord(value.key) ? readKey(value.key.alternative) : undefined;
      if (!key || !alternative || !isNumber(value.key.confidence)) return undefined;
      record.key = { ...key, confidence: value.key.confidence, alternative } satisfies KeyEstimate;
    }
  }
  if (value.modulations !== undefined) {
    if (!Array.isArray(value.modulations)) return undefined;
    const modulations: Modulation[] = [];
    for (const item of value.modulations) {
      const key = readKey(item);
      if (!key || !isNumber(item.start)) return undefined;
      modulations.push({ ...key, start: item.start });
    }
    record.modulations = modulations;
  }
  if (value.chords !== undefined) {
    if (!Array.isArray(value.chords)) return undefined;
    const chords: ChordSegment[] = [];
    for (const item of value.chords) {
      if (
        !isRecord(item) || !isNumber(item.start) || !isNumber(item.end) ||
        !(item.root === null || pitchClass(item.root)) ||
        (item.quality !== "maj" && item.quality !== "min") ||
        !(item.bass === undefined || pitchClass(item.bass))
      ) return undefined;
      const chord: ChordSegment = {
        start: item.start,
        end: item.end,
        root: item.root,
        quality: item.quality,
      };
      if (item.bass !== undefined) chord.bass = item.bass;
      chords.push(chord);
    }
    record.chords = chords;
  }
  if (value.keyOverride !== undefined) {
    const key = readKey(value.keyOverride);
    if (!key) return undefined;
    record.keyOverride = key;
  }
  return record;
}
