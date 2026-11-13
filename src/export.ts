import { mixWavBlobs } from "./audio-core";
import { getStem } from "./storage";
import { type Project, type Stem, STEM_LABELS, STEMS } from "./types";
import { safeFileName } from "./view/format";

export async function exportStem(project: Project, stem: Stem): Promise<void> {
  const stored = await getStem(project.id, stem);
  if (!stored) throw new Error(`The ${STEM_LABELS[stem]} stem is missing.`);
  downloadBlob(stored.blob, `${safeFileName(project.name)}-${stem}.wav`);
}

export async function exportMix(project: Project): Promise<void> {
  const active = STEMS.filter((stem) =>
    project.completedStems.includes(stem) &&
    !project.mutedStems.includes(stem) &&
    project.volumes[stem] > 0
  );
  const records = await Promise.all(
    active.map((stem) => getStem(project.id, stem)),
  );
  if (records.some((record) => !record)) {
    throw new Error("One or more project stem files are missing.");
  }
  const blob = await mixWavBlobs(
    records.map((record) => record!.blob),
    active.map((stem) => project.volumes[stem]),
  );
  downloadBlob(blob, `${safeFileName(project.name)}-mix.wav`);
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
