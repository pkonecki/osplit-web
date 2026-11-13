import { appUrl } from "./paths";
import {
  deleteModelVariants,
  getModel,
  latestModelVariant,
  putModel,
} from "./storage";
import type { Quality, Stem } from "./types";

/** Size and SHA-256 of one model file, from the build's models/models.json. */
export interface ModelEntry {
  size: number;
  sha256: string;
}

/** Model entries keyed by path below models/, e.g. "fp16/bass.fp16.onnx". */
export type ModelManifest = Record<string, ModelEntry>;

export const MODEL_MANIFEST_PATH = "models/models.json";

export function modelKey(quality: Quality, stem: Stem): string {
  return quality === "fp16"
    ? `fp16/${stem}.fp16.onnx`
    : `fp32/${stem}.onnx`;
}

/**
 * IndexedDB key of a cached model. Including the checksum means a changed
 * model is downloaded again instead of the stale copy being reused.
 */
export function modelCacheKey(key: string, entry: ModelEntry): string {
  return `${key}@${entry.sha256}`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Rejects a download whose size or checksum differs from the model list. */
export async function verifyModelBytes(
  key: string,
  bytes: ArrayBuffer,
  entry: ModelEntry,
): Promise<void> {
  if (bytes.byteLength !== entry.size) {
    throw new Error(
      `The downloaded model ${key} is incomplete (${bytes.byteLength} of ${entry.size} bytes). Try again.`,
    );
  }
  if (await sha256Hex(bytes) !== entry.sha256) {
    throw new Error(
      `The downloaded model ${key} is corrupted (checksum mismatch). Try again.`,
    );
  }
}

export function parseModelManifest(value: unknown): ModelManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model list is not valid.");
  }
  const manifest: ModelManifest = {};
  for (const [key, entry] of Object.entries(value)) {
    const { size, sha256 } = (entry ?? {}) as Partial<ModelEntry>;
    if (
      typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 ||
      typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      throw new Error(`The model list entry for ${key} is not valid.`);
    }
    manifest[key] = { size, sha256 };
  }
  return manifest;
}

let manifestRequest: Promise<ModelManifest> | undefined;

/** Fetches the model list once per worker; a failed fetch is retried later. */
export function loadModelManifest(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelManifest> {
  manifestRequest ??= (async () => {
    // Revalidate on every worker so a new deploy's checksums are seen at once.
    const response = await fetchImpl(appUrl(MODEL_MANIFEST_PATH), {
      cache: "no-cache",
    });
    if (!response.ok) {
      throw new Error(`Could not load the model list (${response.status}).`);
    }
    return parseModelManifest(await response.json());
  })();
  manifestRequest.catch(() => {
    manifestRequest = undefined;
  });
  return manifestRequest;
}

/** For tests: forget the fetched model list. */
export function resetModelManifest(): void {
  manifestRequest = undefined;
}

export interface LoadModelOptions {
  /** Download progress of this model, 0–1. */
  onProgress(fraction: number): void;
  /** Throws to abort, e.g. when the task was cancelled. */
  checkCancelled(): void;
  fetchImpl?: typeof fetch;
}

/**
 * Returns a model's bytes from the IndexedDB cache, or downloads, verifies and
 * caches it. Without network access, the most recently cached copy is used.
 */
export async function loadModel(
  quality: Quality,
  stem: Stem,
  options: LoadModelOptions,
): Promise<ArrayBuffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const key = modelKey(quality, stem);

  let manifest: ModelManifest;
  try {
    manifest = await loadModelManifest(fetchImpl);
  } catch (error) {
    const fallback = await latestModelVariant(key);
    if (fallback) return fallback.blob.arrayBuffer();
    throw error;
  }
  const entry = manifest[key];
  if (!entry) throw new Error(`The model list has no entry for ${key}.`);

  const cacheKey = modelCacheKey(key, entry);
  const cached = await getModel(cacheKey);
  if (cached) return cached.blob.arrayBuffer();
  options.checkCancelled();

  const response = await fetchImpl(appUrl(`models/${key}`));
  if (!response.ok) {
    throw new Error(`Could not download the ${stem} ${quality} model.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Could not read the ${stem} model download.`);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let downloaded = 0;
  while (true) {
    options.checkCancelled();
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value as Uint8Array<ArrayBuffer>);
      downloaded += value.length;
      options.onProgress(Math.min(1, downloaded / entry.size));
    }
  }
  const blob = new Blob(chunks, { type: "application/octet-stream" });
  chunks.length = 0;
  const bytes = await blob.arrayBuffer();
  await verifyModelBytes(key, bytes, entry);

  try {
    await putModel({ key: cacheKey, blob, storedAt: Date.now() });
  } catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error(
        "Not enough browser storage for the models. Delete local projects or free storage.",
      );
    }
    throw error;
  }
  // Older copies of this model are no longer needed.
  await deleteModelVariants(key, cacheKey).catch((error: unknown) => {
    console.warn(`Could not remove old copies of ${key}.`, error);
  });
  return bytes;
}
