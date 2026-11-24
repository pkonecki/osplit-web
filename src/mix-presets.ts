import { soloStems } from "./mixing";
import type { Project, Stem } from "./types";

/**
 * Mix presets: a fixed list. Applying one sets the stems' volumes, mutes
 * and solos (the click is left alone); any change afterwards makes the mix
 * "custom" (no preset matches).
 */

export interface MixPreset {
  id: string;
  label: string;
  /** Stems heard; the others are muted. */
  heard: (stem: Stem) => boolean;
}

export const MIX_PRESETS: readonly MixPreset[] = [
  { id: "full", label: "Full mix", heard: () => true },
  { id: "no-vocals", label: "No vocals", heard: (stem) => stem !== "vocals" },
  { id: "drums-bass", label: "Drums + bass", heard: (stem) => stem === "drums" || stem === "bass" },
];

/** The project with `preset` applied to its stems. */
export function applyMixPreset(project: Project, preset: MixPreset): Project {
  const volumes = { ...project.volumes };
  for (const stem of project.completedStems) volumes[stem] = 1;
  return {
    ...project,
    volumes,
    mutedStems: project.completedStems.filter((stem) => !preset.heard(stem)),
    // Solos are cleared, except the click's.
    soloStems: soloStems(project).filter((track) => track === "click"),
  };
}

/** The preset the project's mix matches, or null for a custom mix. */
export function activeMixPreset(project: Project): MixPreset | null {
  const solos = soloStems(project).filter((track) => track !== "click");
  if (solos.length) return null;
  return MIX_PRESETS.find((preset) =>
    project.completedStems.every((stem) =>
      (project.volumes[stem] ?? 1) === 1 &&
      project.mutedStems.includes(stem) === !preset.heard(stem)
    )
  ) ?? null;
}
