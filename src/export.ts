import {
  CHANNELS,
  SAMPLE_RATE,
  type StereoChannels,
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
import { createPitchShifter } from "./player/pitch-shifter";
import {
  activeLoop,
  busTranspose,
  type LoopRegion,
  projectSemitones,
  projectSpeed,
} from "./practice";
import { getStem } from "./storage";
import { type Project, type Stem, STEM_LABELS, STEMS } from "./types";
import { safeFileName } from "./view/format";
import { createZip, type ZipEntry } from "./zip";

const EXPORT_FORMAT_KEY = "osplit-export-format";
const EXPORT_PRACTICE_KEY = "osplit-export-practice";

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

/** Whether mix exports apply the project's speed, key and loop (this browser). */
export function exportAppliesPractice(): boolean {
  try {
    return localStorage.getItem(EXPORT_PRACTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setExportAppliesPractice(apply: boolean): void {
  try {
    localStorage.setItem(EXPORT_PRACTICE_KEY, apply ? "1" : "0");
  } catch {
    // Not remembered without storage.
  }
}

/** The practice settings a mix export applies, or null for the plain mix. */
function exportPractice(project: Project): MixPractice | null {
  if (!exportAppliesPractice()) return null;
  const practice = {
    speed: projectSpeed(project),
    semitones: projectSemitones(project),
    region: activeLoop(project),
  };
  return practice.speed === 1 && practice.semitones === 0 && !practice.region
    ? null
    : practice;
}

/** Speed, key and the part of the track (an active loop) a mix renders. */
export interface MixPractice {
  speed: number;
  semitones: number;
  region: LoopRegion | null;
}

/** File name part for the mix: "mix", or "mix-practice" with settings applied. */
function mixName(project: Project): string {
  return exportPractice(project) ? "mix-practice" : "mix";
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
    `${safeFileName(project.name)}-${mixName(project)}.${format}`,
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
  entries.push({
    name: `${base}-${mixName(project)}.${format}`,
    data: await mixFile(project, format),
  });
  downloadBlob(await createZip(entries), `${base}-stems.zip`);
}

/**
 * The current mix as a file: mute, solo and volumes, as the player plays it,
 * and the speed, key and loop when exports apply them.
 */
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
  const gains = active.map((stem) => stemVolume(project, stem));
  const practice = exportPractice(project);
  const mixed = practice
    ? await renderPracticeMix(decoded, gains, practice)
    : mixStems(decoded, gains);
  return format === "wav"
    ? encodeWav(mixed, mixed.length / CHANNELS)
    : encodeFlac(Int16Array.from(mixed, toPcm16));
}

/**
 * Mixes stems as the player plays them with practice settings, in an offline
 * audio context: sources at the speed, through the pitch shifter, over the
 * loop region only when one is given. Returns interleaved stereo, scaled
 * down if it would clip, like `mixStems`.
 */
export async function renderPracticeMix(
  stems: StereoChannels[],
  gains: number[],
  practice: MixPractice,
): Promise<Float32Array> {
  if (stems.length === 0 || stems.length !== gains.length) {
    throw new Error("No usable stems are selected for the mix.");
  }
  const frameCount = stems[0].left.length;
  const start = practice.region?.start ?? 0;
  const length = (practice.region?.end ?? frameCount / SAMPLE_RATE) - start;
  const outputFrames = Math.max(1, Math.round((length / practice.speed) * SAMPLE_RATE));
  const transpose = busTranspose("buffer", practice.speed, practice.semitones);
  // The shifter delays its output; render extra and drop that much.
  const padding = transpose === 0 ? 0 : SAMPLE_RATE;
  const context = new OfflineAudioContext(
    CHANNELS,
    outputFrames + padding,
    SAMPLE_RATE,
  );
  const bus = new GainNode(context);
  let delay = 0;
  if (transpose === 0) {
    bus.connect(context.destination);
  } else {
    const shifter = await createPitchShifter(context);
    await shifter.setSemitones(transpose);
    bus.connect(shifter.node).connect(context.destination);
    delay = Math.round(shifter.latency * SAMPLE_RATE);
  }
  stems.forEach((stem, index) => {
    const buffer = new AudioBuffer({
      length: frameCount,
      numberOfChannels: CHANNELS,
      sampleRate: SAMPLE_RATE,
    });
    buffer.copyToChannel(stem.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(stem.right as Float32Array<ArrayBuffer>, 1);
    const source = new AudioBufferSourceNode(context, {
      buffer,
      playbackRate: practice.speed,
    });
    source.connect(new GainNode(context, { gain: gains[index] })).connect(bus);
    source.start(0, start, length);
  });
  const rendered = await context.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const output = new Float32Array(outputFrames * CHANNELS);
  let peak = 0;
  for (let frame = 0; frame < outputFrames; frame++) {
    const l = left[frame + delay] ?? 0;
    const r = right[frame + delay] ?? 0;
    output[frame * CHANNELS] = l;
    output[frame * CHANNELS + 1] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  if (peak > 1) {
    for (let i = 0; i < output.length; i++) output[i] /= peak;
  }
  return output;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
