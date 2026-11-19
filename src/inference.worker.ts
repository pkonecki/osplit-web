import * as ort from "onnxruntime-web";
import ortWasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { CHANNELS } from "./audio-core";
import { FlacEncoder } from "./flac";
import { probeGpu } from "./gpu";
import type { InferenceRequest, InferenceResponse } from "./messages";
import type { ModelFile } from "./models";
import { PeakBuilder } from "./peaks";
import { DemucsSeparator } from "./separators/demucs";
import type { Provider, Separator, SeparatorContext } from "./separators/separator";
import { SpleeterSeparator } from "./separators/spleeter";
import type { Stem } from "./types";

type WorkerRequest = InferenceRequest;
type WorkerResponse = InferenceResponse;
type SeparateRequest = Extract<WorkerRequest, { type: "separate" }>;

const cancelled = new Set<string>();

// Load ONNX Runtime's WASM glue from its own file. With the copy embedded in this
// bundle, its worker threads would start this worker script instead and crash.
ort.env.wasm.wasmPaths = { mjs: ortWasmModuleUrl, wasm: ortWasmUrl };

// Must be set before the first session initializes the WASM runtime, which also
// backs the WebGPU provider. Matches ONNX Runtime's own default thread count.
ort.env.wasm.numThreads = crossOriginIsolated
  ? Math.min(4, Math.ceil((navigator.hardwareConcurrency || 1) / 2))
  : 1;

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "cancel") {
    cancelled.add(event.data.id);
  } else {
    void separate(event.data);
  }
});

function contextFor(id: string): SeparatorContext {
  return {
    report: (stage, progress) => report(id, stage, progress),
    reportDownload: (file, progress) => reportDownload(id, file, progress),
    checkCancelled: () => checkCancelled(id),
  };
}

function separatorFor(request: SeparateRequest): Separator {
  const context = contextFor(request.id);
  return request.model === "htdemucs-6s"
    ? new DemucsSeparator(context)
    : new SpleeterSeparator(request.quality, context);
}

async function separate(request: SeparateRequest): Promise<void> {
  const { id } = request;
  const demucs = request.model === "htdemucs-6s";
  let separator = separatorFor(request);
  try {
    report(id, "Loading models", 0);
    const gpu = await probeGpu();
    if (demucs && !gpu.webgpu) {
      throw new Error(
        "Demucs needs WebGPU, which this browser does not offer. Separate with Spleeter instead.",
      );
    }
    let provider: Provider = gpu.webgpu ? "webgpu" : "wasm";
    reportProvider(id, provider);

    // Spleeter retries on the CPU when WebGPU fails; Demucs is far too slow
    // there (slower than real time), so it stops instead.
    const retryOnCpu = async (error: unknown) => {
      if (demucs || provider !== "webgpu" || cancelled.has(id)) {
        throw demucs && !cancelled.has(id) ? demucsFailure(error) : error;
      }
      console.warn("WebGPU failed; retrying with WASM.", error);
      await separator.release();
      separator = separatorFor(request);
      provider = "wasm";
      reportProvider(id, provider);
      report(id, "Retrying on CPU…", 0);
      await separator.load(provider);
    };

    try {
      await separator.load(provider);
    } catch (error) {
      await retryOnCpu(error);
    }
    let outputs: SeparationResult;
    try {
      outputs = await runSeparation(request.samples, separator, id);
    } catch (error) {
      await retryOnCpu(error);
      outputs = await runSeparation(request.samples, separator, id);
    }
    if (cancelled.has(id)) {
      self.postMessage({ type: "cancelled", id } satisfies WorkerResponse);
    } else {
      self.postMessage({ type: "complete", id, ...outputs } satisfies WorkerResponse);
    }
  } catch (error) {
    if (cancelled.has(id)) {
      self.postMessage({ type: "cancelled", id } satisfies WorkerResponse);
    } else {
      self.postMessage(
        {
          type: "error",
          id,
          message: error instanceof Error ? error.message : "Stem separation failed.",
        } satisfies WorkerResponse,
      );
    }
  } finally {
    await separator.release();
    cancelled.delete(id);
  }
}

function demucsFailure(error: unknown): Error {
  console.warn("Demucs failed on WebGPU.", error);
  const detail = error instanceof Error ? ` (${error.message})` : "";
  return new Error(
    `Demucs could not run on this GPU${detail}. Separate with Spleeter instead.`,
  );
}

interface SeparationResult {
  stems: Partial<Record<Stem, Blob>>;
  peaks: Partial<Record<Stem, Float32Array>>;
}

/**
 * Runs the separator and encodes each stem to FLAC as its samples become
 * final, so no full-length copy of the output is kept. The same samples feed
 * each stem's waveform overview.
 */
async function runSeparation(
  samples: Float32Array,
  separator: Separator,
  id: string,
): Promise<SeparationResult> {
  if (samples.length === 0 || samples.length % CHANNELS !== 0) {
    throw new Error("The decoded source has no valid stereo samples.");
  }
  const frameCount = samples.length / CHANNELS;
  const encoders = separator.stems.map(() => new FlacEncoder());
  const peakBuilders = separator.stems.map(() => new PeakBuilder(frameCount));
  await separator.run(samples, (source, pcm) => {
    encoders[source].push(pcm);
    peakBuilders[source].push(pcm);
  });
  checkCancelled(id);
  // finish() copies each stem's frames into its Blob: one stem at a time, so
  // only one extra copy exists at once.
  const stems: Partial<Record<Stem, Blob>> = {};
  const peaks: Partial<Record<Stem, Float32Array>> = {};
  separator.stems.forEach((stem, index) => {
    stems[stem] = encoders[index].finish();
    peaks[stem] = peakBuilders[index].result();
  });
  return { stems, peaks };
}

let lastDownloadReport = "";

/** Reports download progress only when the shown value changes. */
function reportDownload(id: string, file: ModelFile, progress: number): void {
  const stage = `Downloading ${file.label} model`;
  const signature = `${id}:${stage}:${progress}`;
  if (signature === lastDownloadReport) return;
  lastDownloadReport = signature;
  report(id, stage, progress);
}

function report(id: string, stage: string, progress: number): void {
  self.postMessage({ type: "progress", id, stage, progress } satisfies WorkerResponse);
}

function reportProvider(id: string, provider: Provider): void {
  self.postMessage({ type: "provider", id, provider } satisfies WorkerResponse);
}

function checkCancelled(id: string): void {
  if (cancelled.has(id)) {
    throw new DOMException("Separation cancelled.", "AbortError");
  }
}
