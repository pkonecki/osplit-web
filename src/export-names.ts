import type { Track } from "./types";

/**
 * The name of a zip of stems: "<name>-stems.zip" with every stem (the click
 * may come along), else "<name>-<stem>-<stem>.zip" for the ones chosen.
 */
export function stemsZipName(base: string, tracks: readonly Track[], stemCount: number): string {
  const stems = tracks.filter((track) => track !== "click");
  if (stems.length === stemCount) return `${base}-stems.zip`;
  return `${base}-${tracks.join("-")}.zip`;
}
