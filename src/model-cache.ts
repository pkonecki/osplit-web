import { loadModel, modelFiles } from "./models";
import { deleteModelVariants, latestModelVariant } from "./storage";
import type { ModelId } from "./types";

/**
 * The separation models kept in this browser, for Settings: whether each is
 * downloaded, the space it takes, and downloading or deleting it ahead of
 * time. Separation downloads them on first use anyway (src/models.ts).
 */

export interface ModelStatus {
  /** Every file of the model is cached. */
  downloaded: boolean;
  /** Bytes the cached files take. */
  bytes: number;
}

export async function modelStatus(model: ModelId): Promise<ModelStatus> {
  let bytes = 0;
  let downloaded = true;
  for (const file of modelFiles(model)) {
    const record = await latestModelVariant(file.key);
    if (record) bytes += record.blob.size;
    else downloaded = false;
  }
  return { downloaded, bytes };
}

/** Removes every cached copy of the model's files. */
export async function deleteModel(model: ModelId): Promise<void> {
  for (const file of modelFiles(model)) await deleteModelVariants(file.key, "");
}

/** Downloads and caches the model's files; `onProgress` gets 0–1 overall. */
export async function downloadModel(
  model: ModelId,
  onProgress: (fraction: number) => void,
  checkCancelled: () => void = () => {},
): Promise<void> {
  const files = modelFiles(model);
  for (let index = 0; index < files.length; index++) {
    await loadModel(files[index], {
      onProgress: (fraction) => onProgress((index + fraction) / files.length),
      checkCancelled,
    });
  }
  onProgress(1);
}
