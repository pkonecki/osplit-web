import { decodeStem } from "../audio-decode";
import { SAMPLE_RATE } from "../audio-core";
import { type BeatGrid, effectiveGrid } from "../analysis/grid";
import { analysisLength, downmixRange, rms } from "../analysis/onset";
import type { AnalysisRequest, AnalysisResponse } from "../messages";
import { getAnalysis, getStem, putAnalysis } from "../storage";
import { VOCALS_WEIGHT } from "../analysis/tonal";
import type { AnalysisRecord, GridEdits, MusicalKey, Project, Stem } from "../types";
import { describeError, workerCrash } from "../view/format";

/**
 * Rhythm, key and chord analysis of a project's stems: decoded and mixed down
 * here, analysed in a worker, stored with the project. It runs after each
 * separation and on request; a failure never affects the project or its stems.
 */

/** Bump when the analysis changes; older records are analyzed again. */
export const ALGORITHM_VERSION = 2;
/**
 * Records from this version on still have a valid beat grid: they are shown
 * while the newer analysis runs, and the user's corrections carry over.
 */
const GRID_COMPATIBLE_VERSION = 1;
/** Below this level the drum stem is treated as empty: all stems are used. */
const DRUMS_MIN_RMS = 0.005;
/** Output samples mixed down between yields to the page. */
const DOWNMIX_SLICE = 1 << 19;

export interface AnalysisStatus {
  running: boolean;
  stage: string;
  /** 0–100 while running. */
  progress: number;
  /** Why the last analysis failed, if it did. */
  error: string | null;
}

interface Job {
  projectId: string;
  id: string;
  stage: string;
  progress: number;
  worker?: Worker;
  cancelled: boolean;
  reject?: (error: Error) => void;
}

/** Stored analyses by project; null when the project has none (yet). */
const records = new Map<string, AnalysisRecord | null>();
const errors = new Map<string, string>();
let job: Job | null = null;
let listener: (projectId: string) => void = () => {};

/** Sets what runs when a project's analysis or its progress changes. */
export function onAnalysisChange(callback: (projectId: string) => void): void {
  listener = callback;
}

export function analysisStatus(projectId: string): AnalysisStatus {
  const running = job?.projectId === projectId;
  return {
    running,
    stage: running ? job!.stage : "",
    progress: running ? Math.round(job!.progress) : 0,
    error: errors.get(projectId) ?? null,
  };
}

/** The project's analysis if loaded: a record, null for none, undefined if unknown. */
export function cachedAnalysis(projectId: string): AnalysisRecord | null | undefined {
  return records.get(projectId);
}

/** The last grid computed, by record, so callers can compare grids by identity. */
const grids = new WeakMap<AnalysisRecord, BeatGrid | null>();

/** The beat grid of a loaded analysis, with the user's edits. */
export function projectGrid(projectId: string): BeatGrid | null {
  const record = records.get(projectId);
  if (!record) return null;
  if (!grids.has(record)) grids.set(record, effectiveGrid(record));
  return grids.get(record)!;
}

/**
 * Reads the project's analysis from storage. A record from an older version
 * of the analysis is redone at once: meanwhile it is shown if its beat grid
 * is still valid, else it counts as none.
 */
export async function loadAnalysis(project: Project): Promise<AnalysisRecord | null> {
  if (records.has(project.id)) return records.get(project.id)!;
  const stored = await getAnalysis(project.id);
  const outdated = Boolean(stored && stored.algorithmVersion !== ALGORITHM_VERSION);
  const usable = stored &&
      stored.algorithmVersion >= GRID_COMPATIBLE_VERSION &&
      stored.algorithmVersion <= ALGORITHM_VERSION
    ? stored
    : null;
  records.set(project.id, usable);
  listener(project.id);
  if (outdated && project.completedStems.length) {
    void analyzeProject(project, { keepEdits: usable !== null });
  }
  return usable;
}

/** Forgets a project's analysis (its stems changed, or it was deleted). */
export function forgetAnalysis(projectId: string): void {
  if (job?.projectId === projectId) cancelAnalysis();
  records.delete(projectId);
  errors.delete(projectId);
}

/** Saves corrections to the project's grid; returns the updated record. */
export async function saveGridEdits(
  projectId: string,
  edits: GridEdits,
): Promise<AnalysisRecord | null> {
  const record = records.get(projectId);
  if (!record) return null;
  const updated: AnalysisRecord = { ...record, edits };
  records.set(projectId, updated);
  listener(projectId);
  await putAnalysis(updated);
  return updated;
}

/** Sets the key the user chose (undefined: back to the detected key). */
export async function saveKeyOverride(
  projectId: string,
  key: MusicalKey | undefined,
): Promise<AnalysisRecord | null> {
  const record = records.get(projectId);
  if (!record) return null;
  const updated: AnalysisRecord = { ...record };
  if (key) updated.keyOverride = { tonic: key.tonic, mode: key.mode };
  else delete updated.keyOverride;
  records.set(projectId, updated);
  listener(projectId);
  await putAnalysis(updated);
  return updated;
}

/** Stops the running analysis, if any. */
export function cancelAnalysis(): void {
  const current = job;
  if (!current) return;
  current.cancelled = true;
  current.worker?.terminate();
  current.reject?.(new DOMException("Analysis cancelled.", "AbortError"));
  job = null;
  listener(current.projectId);
}

/**
 * Analyzes the project's beats, key and chords (replacing any running
 * analysis) and stores the result. With `keepEdits`, the user's grid and key
 * corrections carry over from the current record (the stems are unchanged).
 * Never throws: a failure is kept for `analysisStatus`.
 */
export async function analyzeProject(
  project: Project,
  options: { keepEdits?: boolean } = {},
): Promise<void> {
  cancelAnalysis();
  const current: Job = {
    projectId: project.id,
    id: crypto.randomUUID(),
    stage: "Decoding stems",
    progress: 0,
    cancelled: false,
  };
  job = current;
  errors.delete(project.id);
  listener(project.id);
  const report = (stage: string, progress: number) => {
    current.stage = stage;
    current.progress = progress;
    if (job === current) listener(project.id);
  };
  try {
    const signals = await prepareSignals(project, current, report);
    if (current.cancelled) return;
    report("Analyzing", 40);
    const worker = new Worker(
      new URL("../analysis.worker.ts", import.meta.url),
      { type: "module" },
    );
    current.worker = worker;
    const result = await new Promise<AnalysisResponse & { type: "complete" }>(
      (resolve, reject) => {
        current.reject = reject;
        worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
          const message = event.data;
          if (message.id !== current.id) return;
          if (message.type === "progress") {
            report(message.stage, 40 + message.progress * 60);
          } else if (message.type === "complete") {
            resolve(message);
          } else {
            reject(new Error(message.message));
          }
        };
        worker.onerror = (event) =>
          reject(workerCrash(event, "The analysis stopped unexpectedly."));
        const transfer = [signals.source, signals.bass, signals.harmonic]
          .filter((signal): signal is Float32Array => signal !== undefined)
          .map((signal) => signal.buffer);
        worker.postMessage(
          {
            type: "analyze",
            id: current.id,
            source: signals.source,
            sourceName: signals.sourceName,
            bass: signals.bass,
            harmonic: signals.harmonic,
          } satisfies AnalysisRequest,
          transfer,
        );
      },
    );
    if (current.cancelled) return;
    const record: AnalysisRecord = {
      projectId: project.id,
      algorithmVersion: ALGORITHM_VERSION,
      duration: signals.duration,
      ...result.result,
    };
    const previous = records.get(project.id);
    if (options.keepEdits && previous) {
      if (previous.edits) record.edits = previous.edits;
      if (previous.keyOverride) record.keyOverride = previous.keyOverride;
    }
    if (await putAnalysis(record)) records.set(project.id, record);
  } catch (error) {
    if (current.cancelled) return;
    console.warn("Analysis failed.", error);
    errors.set(project.id, `Could not analyze the track: ${describeError(error)}`);
  } finally {
    current.worker?.terminate();
    if (job === current) {
      job = null;
      listener(project.id);
    }
  }
}

/**
 * Decodes the stems, one at a time, into mono signals at ANALYSIS_RATE: the
 * drums (or, when they are silent, every stem summed) to follow the beat,
 * the bass, and the harmonic mix (no drums) for key and chords.
 */
async function prepareSignals(
  project: Project,
  current: Job,
  report: (stage: string, progress: number) => void,
): Promise<{
  source: Float32Array;
  sourceName: "drums" | "mix";
  bass?: Float32Array;
  harmonic?: Float32Array;
  duration: number;
}> {
  let duration = 0;
  let decoded = 0;
  const decode = async (stem: Stem, into?: Float32Array) => {
    if (!project.completedStems.includes(stem)) return into ?? null;
    const stored = await getStem(project.id, stem);
    if (!stored) throw new Error("A stem is missing.");
    const { left, right } = await decodeStem(stored.blob);
    duration = Math.max(duration, left.length / SAMPLE_RATE);
    const output = into ?? new Float32Array(analysisLength(left, right));
    for (let from = 0; from < output.length; from += DOWNMIX_SLICE) {
      if (current.cancelled) throw new DOMException("Analysis cancelled.", "AbortError");
      downmixRange(left, right, output, from, from + DOWNMIX_SLICE);
      // Lets the page respond between slices.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    report("Decoding stems", 5 + (++decoded / project.completedStems.length) * 35);
    return output;
  };
  report("Decoding stems", 5);
  const drums = await decode("drums");
  const bass = await decode("bass") ?? undefined;
  let harmonic = await decode("piano");
  harmonic = await decode("other", harmonic ?? undefined);
  const vocals = await decode("vocals");
  const parts = [drums, bass, harmonic, vocals].filter((part): part is Float32Array => !!part);
  if (parts.length === 0) throw new Error("The project has no stems to analyze.");
  const length = Math.max(...parts.map((part) => part.length));
  const addInto = (target: Float32Array, part: Float32Array | null | undefined, gain = 1) => {
    if (!part) return;
    for (let i = 0; i < target.length && i < part.length; i++) target[i] += gain * part[i];
  };
  // No drums to follow: use everything.
  let source = drums;
  let sourceName: "drums" | "mix" = "drums";
  if (!drums || rms(drums) < DRUMS_MIN_RMS) {
    source = new Float32Array(length);
    for (const part of parts) addInto(source, part);
    sourceName = "mix";
  }
  // Harmony: everything but the drums, with the vocals quieter.
  if (!harmonic && (bass || vocals)) harmonic = new Float32Array(length);
  if (harmonic) {
    addInto(harmonic, bass);
    addInto(harmonic, vocals, VOCALS_WEIGHT);
  }
  return { source: source!, sourceName, bass, harmonic: harmonic ?? undefined, duration };
}
