import { resampleStereo } from "../audio-core";
import type { InferenceRequest, InferenceResponse } from "../messages";
import { requestRender, state } from "../state";
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
    const audioContext = new AudioContext({ sampleRate: 44_100 });
    let decoded: AudioBuffer;
    try {
      decoded = await audioContext.decodeAudioData(
        await source.blob.arrayBuffer(),
      );
    } finally {
      await audioContext.close();
    }
    if (abortSeparation) {
      throw new DOMException("Separation cancelled.", "AbortError");
    }
    const left = decoded.getChannelData(0).slice();
    const right = decoded.numberOfChannels > 1
      ? decoded.getChannelData(1).slice()
      : left.slice();
    const samples = resampleStereo(left, right, decoded.sampleRate);
    const id = crypto.randomUUID();
    const worker = new Worker(
      new URL("../inference.worker.ts", import.meta.url),
      { type: "module" },
    );
    inferenceWorker = worker;

    const stems = await new Promise<Record<Stem, Blob>>((resolve, reject) => {
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
          resolve(message.stems);
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
    state.selectedProject = await completeSeparation(project.id, stems);
    state.progressLabel = "Separation complete";
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

export function cancelSeparation(): void {
  if (!state.working) return;
  abortSeparation = true;
  inferenceWorker?.terminate();
  inferenceWorker = undefined;
  rejectInference?.(new DOMException("Separation cancelled.", "AbortError"));
}
