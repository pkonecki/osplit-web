import * as ort from "onnxruntime-web";
import ortWasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import {
  CHANNELS,
  encodeWav,
  FREQUENCY_BINS,
  SAMPLES_PER_SEGMENT,
  SEGMENT_FRAMES,
} from "./audio-core";
import {
  logitsToMasks,
  OverlapAddSynthesizer,
  planStft,
  SegmentAnalyzer,
  segmentFrames,
} from "./stft";
import {
  modelDownloadProgress,
  modelLoadedProgress,
  separationProgress,
} from "./progress";
import { loadModel } from "./models";
import { type Quality, type Stem, STEMS } from "./types";

type WorkerRequest =
  | { type: "separate"; id: string; quality: Quality; samples: Float32Array }
  | { type: "cancel"; id: string };

type WorkerResponse =
  | { type: "progress"; id: string; stage: string; progress: number }
  | { type: "complete"; id: string; stems: Record<Stem, Blob> }
  | { type: "error"; id: string; message: string }
  | { type: "cancelled"; id: string };

const cancelled = new Set<string>();
const STEM_INDEX = new Map(STEMS.map((stem, index) => [stem, index]));

// Load ONNX Runtime's WASM glue from its own file. With the copy embedded in this
// bundle, its worker threads would start this worker script instead and crash.
ort.env.wasm.wasmPaths = { mjs: ortWasmModuleUrl, wasm: ortWasmUrl };

// Must be set before the first session initializes the WASM runtime, which also
// backs the WebGPU provider. Matches ONNX Runtime's own default thread count.
ort.env.wasm.numThreads = crossOriginIsolated
  ? Math.min(4, Math.ceil((navigator.hardwareConcurrency || 1) / 2))
  : 1;

interface GpuNavigator {
  gpu?: { requestAdapter(): Promise<unknown | null> };
}

async function preferredProvider(): Promise<"webgpu" | "wasm"> {
  const gpu = (navigator as GpuNavigator).gpu;
  if (!gpu) return "wasm";
  try {
    return (await gpu.requestAdapter()) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "cancel") {
    cancelled.add(event.data.id);
  } else {
    void separate(event.data);
  }
});

async function separate(
  request: Extract<WorkerRequest, { type: "separate" }>,
): Promise<void> {
  const { id, quality } = request;
  let sessions: Partial<Record<Stem, ort.InferenceSession>> = {};
  let provider: "webgpu" | "wasm" = "wasm";
  try {
    report(id, "Loading models", 0);
    provider = await preferredProvider();
    try {
      sessions = await loadSessions(quality, id, provider);
    } catch (error) {
      if (provider !== "webgpu") throw error;
      console.warn(
        "WebGPU session creation failed; retrying with WASM.",
        error,
      );
      await releaseSessions(sessions);
      provider = "wasm";
      report(id, "Retrying on CPU…", 0);
      sessions = await loadSessions(quality, id, provider);
    }

    let outputs: Record<Stem, Blob>;
    try {
      outputs = await runSeparation(request.samples, sessions, id, quality);
    } catch (error) {
      if (provider !== "webgpu" || cancelled.has(id)) throw error;
      console.warn("WebGPU inference failed; retrying with WASM.", error);
      await releaseSessions(sessions);
      provider = "wasm";
      report(id, "Retrying on CPU…", 0);
      sessions = await loadSessions(quality, id, provider);
      outputs = await runSeparation(request.samples, sessions, id, quality);
    }
    if (cancelled.has(id)) {
      self.postMessage({ type: "cancelled", id } satisfies WorkerResponse);
    } else {
      self.postMessage(
        { type: "complete", id, stems: outputs } satisfies WorkerResponse,
      );
    }
  } catch (error) {
    if (cancelled.has(id)) {
      self.postMessage({ type: "cancelled", id } satisfies WorkerResponse);
    } else {
      self.postMessage(
        {
          type: "error",
          id,
          message: error instanceof Error
            ? error.message
            : "Stem separation failed.",
        } satisfies WorkerResponse,
      );
    }
  } finally {
    await releaseSessions(sessions);
    cancelled.delete(id);
  }
}

async function loadSessions(
  quality: Quality,
  id: string,
  provider: "webgpu" | "wasm",
): Promise<Partial<Record<Stem, ort.InferenceSession>>> {
  const sessions: Partial<Record<Stem, ort.InferenceSession>> = {};
  try {
    for (let index = 0; index < STEMS.length; index++) {
      checkCancelled(id);
      const stem = STEMS[index];
      const bytes = await loadModel(quality, stem, {
        onProgress: (fraction) =>
          reportDownload(id, stem, modelDownloadProgress(index, STEMS.length, fraction)),
        checkCancelled: () => checkCancelled(id),
      });
      sessions[stem] = await createSession(bytes, provider);
      report(id, "Loading models", modelLoadedProgress(index, STEMS.length));
    }
    return sessions;
  } catch (error) {
    await releaseSessions(sessions);
    throw error;
  }
}

async function createSession(
  model: ArrayBuffer,
  provider: "webgpu" | "wasm",
): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(model, {
    executionProviders: [provider],
    graphOptimizationLevel: "all",
  });
}

async function releaseSessions(
  sessions: Partial<Record<Stem, ort.InferenceSession>>,
): Promise<void> {
  await Promise.all(
    Object.values(sessions).map(async (session) => {
      try {
        await session?.release();
      } catch {
        // Session teardown must not replace the inference result.
      }
    }),
  );
}

async function runSeparation(
  interleavedSamples: Float32Array,
  sessions: Partial<Record<Stem, ort.InferenceSession>>,
  id: string,
  quality: Quality,
): Promise<Record<Stem, Blob>> {
  if (
    interleavedSamples.length === 0 ||
    interleavedSamples.length % CHANNELS !== 0
  ) {
    throw new Error("The decoded source has no valid stereo samples.");
  }
  const frameCount = interleavedSamples.length / CHANNELS;
  const plan = planStft(frameCount);
  const outputs = STEMS.map(() => new Float32Array(frameCount * CHANNELS));
  const analyzer = new SegmentAnalyzer(interleavedSamples, plan);
  const synthesizer = new OverlapAddSynthesizer(plan, outputs);
  const logits = new Float32Array(
    STEMS.length * CHANNELS * SAMPLES_PER_SEGMENT,
  );

  for (let segment = 0; segment < plan.segmentCount; segment++) {
    checkCancelled(id);
    analyzer.analyze(segment);

    for (const stem of STEMS) {
      checkCancelled(id);
      const session = sessions[stem];
      if (!session) throw new Error(`The ${stem} model is not loaded.`);
      const tensor = new ort.Tensor("float32", analyzer.spectrogram, [
        CHANNELS,
        1,
        SEGMENT_FRAMES,
        FREQUENCY_BINS,
      ]);
      const result = await session.run({ [session.inputNames[0]]: tensor });
      const output = result[session.outputNames[0]];
      if (!output || !(output.data instanceof Float32Array)) {
        throw new Error(`Unexpected output tensor for the ${stem} model.`);
      }
      const stemIndex = STEM_INDEX.get(stem)!;
      logits.set(
        output.data.subarray(0, CHANNELS * SAMPLES_PER_SEGMENT),
        stemIndex * CHANNELS * SAMPLES_PER_SEGMENT,
      );
      tensor.dispose();
      for (const value of Object.values(result)) value.dispose();
    }

    logitsToMasks(logits, STEMS.length, segmentFrames(plan, segment));
    synthesizer.synthesize(segment, analyzer.spectra, logits);
    report(
      id,
      `Separating · ${quality.toUpperCase()}`,
      separationProgress(segment + 1, plan.segmentCount),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  checkCancelled(id);
  return Object.fromEntries(
    STEMS.map((stem, index) => [stem, encodeWav(outputs[index], frameCount)]),
  ) as Record<Stem, Blob>;
}

let lastDownloadReport = "";

/** Reports download progress only when the shown value changes. */
function reportDownload(id: string, stem: Stem, progress: number): void {
  const stage = `Downloading ${stem} model`;
  const signature = `${id}:${stage}:${progress}`;
  if (signature === lastDownloadReport) return;
  lastDownloadReport = signature;
  report(id, stage, progress);
}

function report(id: string, stage: string, progress: number): void {
  self.postMessage(
    { type: "progress", id, stage, progress } satisfies WorkerResponse,
  );
}

function checkCancelled(id: string): void {
  if (cancelled.has(id)) {
    throw new DOMException("Separation cancelled.", "AbortError");
  }
}
