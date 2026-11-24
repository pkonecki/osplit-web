import { peaksFromChannels } from "../peaks";
import { decodedChannels } from "../player";
import { getPeaks, putPeaks } from "../storage";
import type { Project } from "../types";

/**
 * The song's peaks for the chord chart: the loudest stem at each point.
 * Peaks come from the separation (stored with the stems); projects separated
 * before peaks existed get them from the decoded playback buffers once, and
 * they are saved. With streaming playback such projects show no peaks.
 */

let cached: { projectId: string; stems: number; peaks: Float32Array | null } | null = null;

/** The song's peaks if already loaded for `project`. */
export function songPeaks(project: Project): Float32Array | null {
  return cached?.projectId === project.id ? cached.peaks : null;
}

/** Loads (or derives and saves) the song's peaks; resolves null if none. */
export async function loadSongPeaks(project: Project): Promise<Float32Array | null> {
  const count = project.completedStems.length;
  if (cached?.projectId === project.id && cached.stems === count && cached.peaks) return cached.peaks;
  const peaks = await getPeaks(project.id);
  for (const stem of project.completedStems) {
    if (peaks[stem]) continue;
    const channels = decodedChannels(stem);
    if (!channels) continue;
    peaks[stem] = peaksFromChannels(channels[0], channels[1]);
    await putPeaks(project.id, stem, peaks[stem]!);
  }
  const combined = combinedPeaks(Object.values(peaks));
  cached = { projectId: project.id, stems: count, peaks: combined };
  return combined;
}

export function forgetSongPeaks(): void {
  cached = null;
}

/** The loudest of `all` at each point (they have the same length). */
export function combinedPeaks(all: (Float32Array | undefined)[]): Float32Array | null {
  const present = all.filter((peaks): peaks is Float32Array => peaks !== undefined);
  if (!present.length) return null;
  const length = Math.min(...present.map((peaks) => peaks.length));
  const result = new Float32Array(length);
  for (const peaks of present) {
    for (let i = 0; i < length; i++) result[i] = Math.max(result[i], peaks[i]);
  }
  // Scaled so the loudest point fills the cell.
  let top = 0;
  for (const value of result) top = Math.max(top, value);
  if (top > 0) for (let i = 0; i < length; i++) result[i] /= top;
  return result;
}
