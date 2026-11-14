import {
  CHANNELS,
  interleaveStereo,
  resampleStereo,
  SAMPLE_RATE,
} from "../audio-core";
import {
  estimateSeparationBytes,
  isLongForDevice,
  LONG_TRACK_WARNING,
} from "../memory";
import type { InferenceRequest, InferenceResponse } from "../messages";
import { requestRender, showMessage, state } from "../state";
import { completeSeparation, getSource, updateProjectTask } from "../storage";
import type { Project, Stem } from "../types";
import { updateProgressDisplay } from "../view/detail";
import { describeError, workerCrash } from "../view/format";
import { progressPersister } from "./progress";
import { acquireWakeLock, releaseWakeLock } from "./wake-lock";

let inferenceWorker: Worker | undefined;
let rejectInference: ((error: Error) => void) | undefined;
let abortSeparation = false;

export function terminateInferenceWorker(): void {
  inferenceWorker?.terminate();
}

export async function separateProject(project: Project): Promise<void> {
  if (state.working) return;
  const source = await getSource(project.id);
  if (!source) {
    throw new Error("Import a local audio file before separating stems.");
  }
  state.working = true;
  abortSeparation = false;
  state.progress = 0;
  state.progressLabel = "Preparing audio";
  const persist = progressPersister(project.id);
  acquireWakeLock();

  try {
    state.selectedProject = await updateProjectTask(project.id, {
      status: "processing",
      errorMessage: null,
      taskProgress: 0,
      taskStage: "Preparing audio",
    });
    await requestRender();
    const samples = await decodeToStereo(source.blob);
    if (abortSeparation) {
      throw new DOMException("Separation cancelled.", "AbortError");
    }
    const frameCount = samples.length / CHANNELS;
    if (
      isLongForDevice(
        estimateSeparationBytes(frameCount, project.quality),
        (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      )
    ) {
      showMessage(LONG_TRACK_WARNING);
    }
    const id = crypto.randomUUID();
    const worker = new Worker(
      new URL("../inference.worker.ts", import.meta.url),
      { type: "module" },
    );
    inferenceWorker = worker;

    const result = await new Promise<
      { stems: Record<Stem, Blob>; peaks: Record<Stem, Float32Array> }
    >((resolve, reject) => {
      rejectInference = reject;
      worker.onmessage = (event: MessageEvent<InferenceResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          state.progress = message.progress;
          state.progressLabel = message.stage;
          persist.report(message.progress, message.stage);
          updateProgressDisplay();
        } else if (message.type === "complete") {
          resolve({ stems: message.stems, peaks: message.peaks });
        } else if (message.type === "cancelled") {
          reject(new DOMException("Separation cancelled.", "AbortError"));
        } else {
          reject(new Error(message.message));
        }
      };
      worker.onerror = (event) =>
        reject(
          workerCrash(
            event,
            "The separation stopped unexpectedly. This is usually the browser running out of memory: try Low quality or a shorter track.",
          ),
        );
      worker.postMessage(
        {
          type: "separate",
          id,
          quality: project.quality,
          samples,
        } satisfies InferenceRequest,
        [samples.buffer],
      );
    });

    await persist.settled();
    state.selectedProject = await completeSeparation(
      project.id,
      result.stems,
      result.peaks,
    );
    state.progressLabel = "Separation complete";
    if (state.screenMessage === LONG_TRACK_WARNING) state.screenMessage = "";
  } catch (error) {
    const cancelled = error instanceof DOMException &&
      error.name === "AbortError";
    await persist.settled();
    state.selectedProject = await updateProjectTask(project.id, {
      status: cancelled ? "interrupted" : "failed",
      taskProgress: state.progress,
      taskStage: cancelled ? "Cancelled" : "Failed",
      errorMessage: cancelled
        ? "Processing was cancelled. Start again to retry."
        : describeError(error),
    });
    if (!cancelled) state.screenMessage = describeError(error);
  } finally {
    inferenceWorker?.terminate();
    inferenceWorker = undefined;
    rejectInference = undefined;
    state.working = false;
    releaseWakeLock();
    await requestRender();
  }
}

/**
 * Decodes the source file to interleaved stereo at 44.1 kHz. The decoded
 * buffer and the file's bytes stay local to this function, so they can be
 * freed while the separation runs.
 */
async function decodeToStereo(file: Blob): Promise<Float32Array> {
  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  let decoded: AudioBuffer;
  try {
    decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
  } finally {
    await audioContext.close();
  }
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  return decoded.sampleRate === SAMPLE_RATE
    ? interleaveStereo(left, right)
    : resampleStereo(left, right, decoded.sampleRate);
}

export function cancelSeparation(): void {
  if (!state.working) return;
  abortSeparation = true;
  inferenceWorker?.terminate();
  inferenceWorker = undefined;
  rejectInference?.(new DOMException("Separation cancelled.", "AbortError"));
}
