import {
  DEFAULT_CLICK_VOLUME,
  type Project,
  stemLevel,
  type Track,
} from "./types";

/** Soloed rows; projects saved before solo existed have none. */
export function soloStems(project: Project): Track[] {
  return project.soloStems ?? [];
}

/**
 * A row's level in the mix, as on a mixing desk: when any row is soloed,
 * only soloed rows are heard; a muted row stays silent; otherwise the row's
 * volume applies. The click row is muted until turned on. Playback and the
 * exported mix both use this rule.
 */
export function stemVolume(project: Project, track: Track): number {
  const solo = soloStems(project);
  if (solo.length > 0 && !solo.includes(track)) return 0;
  if (track === "click") {
    return project.clickOn ? project.clickVolume ?? DEFAULT_CLICK_VOLUME : 0;
  }
  return project.mutedStems.includes(track) ? 0 : stemLevel(project, track);
}

/** Adds `item` to `list` or removes it. */
export function toggleStem<T extends Track>(list: T[], item: T): T[] {
  return list.includes(item)
    ? list.filter((entry) => entry !== item)
    : [...list, item];
}
