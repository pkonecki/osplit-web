import {
  CHANNELS,
  encodeWav,
  encodeWavPcm16,
  mixStems,
  readWavFrames,
  stereoToPcm16,
  toPcm16,
  WAV_HEADER_BYTES,
} from "./audio-core";
import { decodeStem } from "./audio-decode";
import { type AudioFormat, detectAudioFormat } from "./audio-format";
import { encodeFlac } from "./flac";
import { stemVolume } from "./mixing";
import { getStem } from "./storage";
import { type Project, type Stem, STEM_LABELS, STEMS } from "./types";
import { safeFileName } from "./view/format";
import { createZip, type ZipEntry } from "./zip";

const EXPORT_FORMAT_KEY = "osplit-export-format";

/** The export format chosen in this browser; FLAC unless WAV was picked. */
export function exportFormat(): AudioFormat {
  try {
    return localStorage.getItem(EXPORT_FORMAT_KEY) === "wav" ? "wav" : "flac";
  } catch {
    return "flac";
  }
}

export function setExportFormat(format: AudioFormat): void {
  try {
    localStorage.setItem(EXPORT_FORMAT_KEY, format);
  } catch {
    // Not remembered without storage; the choice still applies to this page.
  }
}

/** A stored stem in the requested format, converted losslessly if needed. */
export async function stemFile(blob: Blob, format: AudioFormat): Promise<Blob> {
  const stored = await detectAudioFormat(blob);
  if (stored === format) return blob;
  if (format === "flac") {
    const bytes = await blob.arrayBuffer();
    const frames = readWavFrames(new DataView(bytes));
    return encodeFlac(new Int16Array(bytes, WAV_HEADER_BYTES, frames * CHANNELS));
  }
  return encodeWavPcm16(stereoToPcm16(await decodeStem(blob)));
}

export async function exportStem(project: Project, stem: Stem): Promise<void> {
  const stored = await getStem(project.id, stem);
  if (!stored) throw new Error(`The ${STEM_LABELS[stem]} stem is missing.`);
  const format = exportFormat();
  downloadBlob(
    await stemFile(stored.blob, format),
    `${safeFileName(project.name)}-${stem}.${format}`,
  );
}

export async function exportMix(project: Project): Promise<void> {
  const format = exportFormat();
  downloadBlob(
    await mixFile(project, format),
    `${safeFileName(project.name)}-mix.${format}`,
  );
}

/**
 * Downloads one zip with every stem and the current mix, in the chosen
 * format. Stems already in that format go in as they are stored.
 */
export async function exportAll(project: Project): Promise<void> {
  const format = exportFormat();
  const base = safeFileName(project.name);
  const entries: ZipEntry[] = [];
  for (const stem of STEMS.filter((s) => project.completedStems.includes(s))) {
    const stored = await getStem(project.id, stem);
    if (!stored) throw new Error(`The ${STEM_LABELS[stem]} stem is missing.`);
    entries.push({
      name: `${base}-${stem}.${format}`,
      data: await stemFile(stored.blob, format),
    });
  }
  entries.push({ name: `${base}-mix.${format}`, data: await mixFile(project, format) });
  downloadBlob(await createZip(entries), `${base}-stems.zip`);
}

/** The current mix as a file: mute, solo and volumes, as the player plays it. */
async function mixFile(project: Project, format: AudioFormat): Promise<Blob> {
  const active = STEMS.filter((stem) =>
    project.completedStems.includes(stem) && stemVolume(project, stem) > 0
  );
  const records = await Promise.all(
    active.map((stem) => getStem(project.id, stem)),
  );
  if (records.some((record) => !record)) {
    throw new Error("One or more project stem files are missing.");
  }
  const decoded = await Promise.all(
    records.map((record) => decodeStem(record!.blob)),
  );
  const mixed = mixStems(decoded, active.map((stem) => stemVolume(project, stem)));
  return format === "wav"
    ? encodeWav(mixed, mixed.length / CHANNELS)
    : encodeFlac(Int16Array.from(mixed, toPcm16));
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
