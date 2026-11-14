import type { Project, Stem } from "./types";

/** Soloed stems; projects saved before solo existed have none. */
export function soloStems(project: Project): Stem[] {
  return project.soloStems ?? [];
}

/**
 * A stem's level in the mix, as on a mixing desk: when any stem is soloed,
 * only soloed stems are heard; a muted stem stays silent; otherwise the
 * stem's volume applies. Playback and the exported mix both use this rule.
 */
export function stemVolume(project: Project, stem: Stem): number {
  const solo = soloStems(project);
  if (solo.length > 0 && !solo.includes(stem)) return 0;
  return project.mutedStems.includes(stem) ? 0 : project.volumes[stem];
}

/** Adds `stem` to `list` or removes it. */
export function toggleStem(list: Stem[], stem: Stem): Stem[] {
  return list.includes(stem)
    ? list.filter((item) => item !== stem)
    : [...list, stem];
}
