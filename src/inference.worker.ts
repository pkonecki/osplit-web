import * as ort from "onnxruntime-web";
import ortWasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import {
  CHANNELS,
  encodeWav,
  fftInPlace,
  FRAME_LENGTH,
  FREQUENCY_BINS,
  HOP_LENGTH,
  makeHannWindow,
  makeSynthesisWindow,
  OVERLAP_BUFFER_SIZE,
  SAMPLES_PER_SEGMENT,
  SEGMENT_FRAMES,
} from "./audio-core";
import { getModel, putModel } from "./storage";
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
  let provider: "webgpu" | "wasm" = "gpu" in navigator ? "webgpu" : "wasm";
  try {
    report(id, "Loading models", 0);
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
      const bytes = await modelBytes(quality, stem, id);
      sessions[stem] = await createSession(bytes, provider);
      report(id, "Loading models", Math.round((index + 1) * 8 / STEMS.length));
    }
    return sessions;
  } catch (error) {
    await releaseSessions(sessions);
    throw error;
  }
}

async function modelBytes(
  quality: Quality,
  stem: Stem,
  id: string,
): Promise<ArrayBuffer> {
  const name = quality === "fp16" ? `${stem}.fp16.onnx` : `${stem}.onnx`;
  const key = `${quality}/${name}`;
  const cached = await getModel(key);
  if (cached) return cached.blob.arrayBuffer();
  checkCancelled(id);

  const response = await fetch(`/models/${key}`);
  if (!response.ok) {
    throw new Error(`Could not download the ${stem} ${quality} model.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Could not read the ${stem} model download.`);
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  const total = Number(response.headers.get("content-length")) || 0;
  while (true) {
    checkCancelled(id);
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      downloaded += value.length;
      if (total > 0) {
        report(
          id,
          `Downloading ${stem} model`,
          Math.max(0, Math.min(7, Math.floor((downloaded / total) * 7))),
        );
      }
    }
  }
  const modelData = new Uint8Array(downloaded);
  let chunkOffset = 0;
  for (const chunk of chunks) {
    modelData.set(chunk, chunkOffset);
    chunkOffset += chunk.length;
  }
  const blob = new Blob([modelData.buffer], {
    type: "application/octet-stream",
  });
  if (!blob.size) throw new Error(`The downloaded ${stem} model is empty.`);
  try {
    await putModel({ key, blob, storedAt: Date.now() });
  } catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error(
        "Not enough browser storage for the models. Delete local projects or free storage.",
      );
    }
    throw error;
  }
  return blob.arrayBuffer();
}

async function createSession(
  model: ArrayBuffer,
  provider: "webgpu" | "wasm",
): Promise<ort.InferenceSession> {
  if (provider === "wasm") {
    ort.env.wasm.numThreads = crossOriginIsolated ? 2 : 1;
  }
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
  const analysisFrameCount = Math.ceil(
    (frameCount + FRAME_LENGTH) / HOP_LENGTH,
  );
  const segmentCount = Math.ceil(analysisFrameCount / SEGMENT_FRAMES);
  const paddedFrameLimit = frameCount + FRAME_LENGTH;

  const outputs = Object.fromEntries(
    STEMS.map((stem) => [stem, new Float32Array(frameCount * CHANNELS)]),
  ) as Record<Stem, Float32Array>;
  const overlap = Array.from(
    { length: STEMS.length * CHANNELS },
    () => new Float32Array(OVERLAP_BUFFER_SIZE),
  );
  const window = makeHannWindow();
  const synthesisWindow = makeSynthesisWindow();
  const real = new Float32Array(FRAME_LENGTH);
  const imaginary = new Float32Array(FRAME_LENGTH);
  const spectrogram = new Float32Array(CHANNELS * SAMPLES_PER_SEGMENT);
  const spectra = new Float32Array(CHANNELS * SAMPLES_PER_SEGMENT * 2);
  const logits = new Float32Array(
    STEMS.length * CHANNELS * SAMPLES_PER_SEGMENT,
  );
  let nextSampleToWrite = 0;

  for (let chunk = 0; chunk < segmentCount; chunk++) {
    checkCancelled(id);
    const firstFrame = chunk * SEGMENT_FRAMES;
    const validFrames = Math.min(
      SEGMENT_FRAMES,
      analysisFrameCount - firstFrame,
    );
    spectrogram.fill(0);
    spectra.fill(0);

    for (let channel = 0; channel < CHANNELS; channel++) {
      for (let time = 0; time < validFrames; time++) {
        const globalFrame = firstFrame + time;
        const sourceStart = globalFrame * HOP_LENGTH - FRAME_LENGTH;
        for (let i = 0; i < FRAME_LENGTH; i++) {
          const sourceIndex = sourceStart + i;
          real[i] = sourceIndex >= 0 && sourceIndex < frameCount
            ? interleavedSamples[sourceIndex * CHANNELS + channel] * window[i]
            : 0;
          imaginary[i] = 0;
        }
        fftInPlace(real, imaginary, false);
        for (let frequency = 0; frequency < FREQUENCY_BINS; frequency++) {
          const feature = (channel * SEGMENT_FRAMES + time) * FREQUENCY_BINS +
            frequency;
          const complex = feature * 2;
          const re = real[frequency];
          const im = imaginary[frequency];
          spectrogram[feature] = Math.hypot(re, im);
          spectra[complex] = re;
          spectra[complex + 1] = im;
        }
      }
    }

    for (const stem of STEMS) {
      checkCancelled(id);
      const session = sessions[stem];
      if (!session) throw new Error(`The ${stem} model is not loaded.`);
      const tensor = new ort.Tensor("float32", spectrogram, [
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
      const destinationOffset = stemIndex * CHANNELS * SAMPLES_PER_SEGMENT;
      logits.set(
        output.data.subarray(0, CHANNELS * SAMPLES_PER_SEGMENT),
        destinationOffset,
      );
      tensor.dispose();
      for (const value of Object.values(result)) value.dispose();
    }

    for (let time = 0; time < validFrames; time++) {
      const globalFrame = firstFrame + time;
      const startSample = globalFrame * HOP_LENGTH;
      for (let channel = 0; channel < CHANNELS; channel++) {
        const featureOffset = (channel * SEGMENT_FRAMES + time) *
          FREQUENCY_BINS;
        for (let frequency = 0; frequency < FREQUENCY_BINS; frequency++) {
          const feature = featureOffset + frequency;
          let maxLogit = -Infinity;
          for (let source = 0; source < STEMS.length; source++) {
            const index = source * CHANNELS * SAMPLES_PER_SEGMENT + feature;
            const scaled = logits[index] * 2;
            logits[index] = scaled;
            maxLogit = Math.max(maxLogit, scaled);
          }
          let denominator = 0;
          for (let source = 0; source < STEMS.length; source++) {
            const index = source * CHANNELS * SAMPLES_PER_SEGMENT + feature;
            logits[index] = Math.exp(logits[index] - maxLogit);
            denominator += logits[index];
          }
          for (let source = 0; source < STEMS.length; source++) {
            const index = source * CHANNELS * SAMPLES_PER_SEGMENT + feature;
            logits[index] /= denominator;
          }
        }

        for (let source = 0; source < STEMS.length; source++) {
          real.fill(0);
          imaginary.fill(0);
          for (let frequency = 0; frequency < FREQUENCY_BINS; frequency++) {
            const feature = featureOffset + frequency;
            const index = source * CHANNELS * SAMPLES_PER_SEGMENT + feature;
            const complex = feature * 2;
            const mask = logits[index];
            real[frequency] = spectra[complex] * mask;
            imaginary[frequency] = spectra[complex + 1] * mask;
            if (frequency > 0) {
              real[FRAME_LENGTH - frequency] = real[frequency];
              imaginary[FRAME_LENGTH - frequency] = -imaginary[frequency];
            }
          }
          fftInPlace(real, imaginary, true);
          const buffer = overlap[source * CHANNELS + channel];
          for (let i = 0; i < FRAME_LENGTH; i++) {
            const ring = (startSample + i) % OVERLAP_BUFFER_SIZE;
            buffer[ring] += real[i] * synthesisWindow[i];
          }
        }
      }

      const safeEnd = Math.min(startSample + HOP_LENGTH, paddedFrameLimit);
      const writeStart = Math.max(nextSampleToWrite, FRAME_LENGTH);
      for (let sample = writeStart; sample < safeEnd; sample++) {
        const outputFrame = sample - FRAME_LENGTH;
        const ring = sample % OVERLAP_BUFFER_SIZE;
        for (let source = 0; source < STEMS.length; source++) {
          const out = outputs[STEMS[source]];
          out[outputFrame * CHANNELS] = overlap[source * CHANNELS][ring];
          out[outputFrame * CHANNELS + 1] =
            overlap[source * CHANNELS + 1][ring];
        }
        for (const buffer of overlap) buffer[ring] = 0;
      }
      nextSampleToWrite = startSample + HOP_LENGTH;
    }
    report(
      id,
      `Separating · ${quality.toUpperCase()}`,
      10 + Math.round((chunk + 1) * 90 / segmentCount),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  checkCancelled(id);
  return Object.fromEntries(
    STEMS.map((stem) => [stem, encodeWav(outputs[stem], frameCount)]),
  ) as Record<Stem, Blob>;
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
