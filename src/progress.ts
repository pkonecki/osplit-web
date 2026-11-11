/** Percent of the progress bar used for downloading and loading the models. */
export const MODEL_PHASE_PERCENT = 10;
/** Part of each model's slot used by its download; the rest is session creation. */
const DOWNLOAD_SHARE = 0.75;

function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Progress while model `index` of `count` downloads, `fraction` being 0–1. */
export function modelDownloadProgress(
  index: number,
  count: number,
  fraction: number,
): number {
  const slot = MODEL_PHASE_PERCENT / count;
  return Math.floor((index + clampFraction(fraction) * DOWNLOAD_SHARE) * slot);
}

/** Progress once model `index` of `count` is downloaded and loaded. */
export function modelLoadedProgress(index: number, count: number): number {
  return Math.floor((index + 1) * MODEL_PHASE_PERCENT / count);
}

/** Progress after `done` of `total` audio segments are separated. */
export function separationProgress(done: number, total: number): number {
  const share = total > 0 ? clampFraction(done / total) : 1;
  return MODEL_PHASE_PERCENT +
    Math.round(share * (100 - MODEL_PHASE_PERCENT));
}
