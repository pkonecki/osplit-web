import { CHANNELS, wavByteLength } from "./audio-core";
import { type ModelId, MODEL_STEMS } from "./types";

/** Total size of the five Spleeter model files (FP32). */
const SPLEETER_FILE_BYTES = 196_600_000;

/** The Demucs FP32 file (models/htdemucs_6s). */
const DEMUCS_FILE_BYTES = 114_556_716;

/**
 * Working memory of one Demucs segment (7.8 s), which Spleeter does not have
 * in this size: about 2 GB in FP32 on ONNX Runtime's CPU backend. On most
 * phones and laptops the GPU shares system memory, so it counts. An estimate
 * until measured on real WebGPU devices.
 */
const DEMUCS_SEGMENT_BYTES = 2_048 * 1024 ** 2;

/** Download size of a model's files, for the model picker. */
export function modelDownloadBytes(model: ModelId): number {
  return model === "htdemucs-6s" ? DEMUCS_FILE_BYTES : SPLEETER_FILE_BYTES;
}

/**
 * ONNX Runtime keeps its own copies of the weights next to the downloaded
 * file, so the models cost several times their file size while loaded.
 */
const MODEL_RUNTIME_FACTOR = 3;

/**
 * Fixed working memory of a separation (WebAssembly heap, worker, decoding).
 * With the model term above, it matches Chromium measurements: renderer
 * memory grew by about 620–700 MB for a 60 s track and 770 MB for 5 minutes
 * (FP16); the estimate errs on the high side for long tracks.
 */
const RUNTIME_BASE_BYTES = 300 * 1024 ** 2;

/** Share of the device memory one tab can use before mobile browsers kill it. */
const DEVICE_MEMORY_SHARE = 0.25;

/** Approximate peak memory a separation of `frameCount` stereo frames needs. */
export function estimateSeparationBytes(
  frameCount: number,
  model: ModelId,
): number {
  const input = frameCount * CHANNELS * 4;
  const stems = MODEL_STEMS[model].length * wavByteLength(frameCount);
  // One stem is copied at a time while the results are turned into Blobs.
  const blobCopy = wavByteLength(frameCount);
  const models = modelDownloadBytes(model) * MODEL_RUNTIME_FACTOR;
  const working = model === "htdemucs-6s" ? DEMUCS_SEGMENT_BYTES : 0;
  return RUNTIME_BASE_BYTES + input + stems + blobCopy + models + working;
}

/**
 * Whether a separation needing `bytes` is likely too much for a device with
 * `deviceMemoryGb` of memory (navigator.deviceMemory, Chromium only, rounded
 * and capped at 8). Unknown device memory never warns.
 */
export function isLongForDevice(
  bytes: number,
  deviceMemoryGb: number | undefined,
): boolean {
  if (!deviceMemoryGb || !Number.isFinite(deviceMemoryGb)) return false;
  return bytes > deviceMemoryGb * 1024 ** 3 * DEVICE_MEMORY_SHARE;
}

export const LONG_TRACK_WARNING =
  "This track is long for this device. If separation stops, try a shorter section.";

/** Memory the decoded stems take for sample-accurate playback (float32). */
export function decodedPlaybackBytes(frameCount: number, stemCount: number): number {
  return frameCount * CHANNELS * 4 * stemCount;
}

/**
 * Which player to use: decoded buffers play in perfect sync, but need the
 * whole track in memory; streaming <audio> players need little memory and
 * are kept in sync by correcting drift.
 */
export function playbackEngineFor(
  frameCount: number,
  stemCount: number,
  deviceMemoryGb: number | undefined,
): "buffer" | "media" {
  return isLongForDevice(decodedPlaybackBytes(frameCount, stemCount), deviceMemoryGb)
    ? "media"
    : "buffer";
}

