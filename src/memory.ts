import { CHANNELS, wavByteLength } from "./audio-core";
import { STEMS, type Quality } from "./types";

/** Total size of the five model files per quality. */
const MODEL_FILE_BYTES: Record<Quality, number> = {
  fp16: 98_400_000,
  fp32: 196_600_000,
};

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
  quality: Quality,
): number {
  const input = frameCount * CHANNELS * 4;
  const stems = STEMS.length * wavByteLength(frameCount);
  // One stem is copied at a time while the results are turned into Blobs.
  const blobCopy = wavByteLength(frameCount);
  const models = MODEL_FILE_BYTES[quality] * MODEL_RUNTIME_FACTOR;
  return RUNTIME_BASE_BYTES + input + stems + blobCopy + models;
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
  "This track is long for this device. If separation stops, try Low quality or a shorter section.";
