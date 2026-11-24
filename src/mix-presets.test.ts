import { describe, expect, it } from "vitest";
import { activeMixPreset, applyMixPreset, MIX_PRESETS } from "./mix-presets";
import { newProject, type Project } from "./types";

function separated(): Project {
  return { ...newProject("Mix"), completedStems: ["vocals", "piano", "drums", "bass", "other"] };
}

const preset = (id: string) => MIX_PRESETS.find((item) => item.id === id)!;

describe("mix presets", () => {
  it("starts as the full mix", () => {
    expect(activeMixPreset(separated())?.id).toBe("full");
  });

  it("mutes what a preset leaves out and resets volumes and solos", () => {
    const project = { ...separated(), volumes: { drums: 0.3 }, soloStems: ["piano" as const, "click" as const] };
    const applied = applyMixPreset(project, preset("drums-bass"));
    expect(applied.mutedStems).toEqual(["vocals", "piano", "other"]);
    expect(applied.volumes.drums).toBe(1);
    expect(applied.soloStems).toEqual(["click"]);
    expect(activeMixPreset(applied)?.id).toBe("drums-bass");
    expect(activeMixPreset(applyMixPreset(project, preset("no-vocals")))?.id).toBe("no-vocals");
    const noBass = applyMixPreset(project, preset("no-bass"));
    expect(noBass.mutedStems).toEqual(["bass"]);
    expect(activeMixPreset(noBass)?.id).toBe("no-bass");
  });

  it("becomes custom after any change", () => {
    const applied = applyMixPreset(separated(), preset("no-vocals"));
    expect(activeMixPreset({ ...applied, volumes: { ...applied.volumes, bass: 0.5 } })).toBeNull();
    expect(activeMixPreset({ ...applied, soloStems: ["drums"] })).toBeNull();
    expect(activeMixPreset({ ...applied, mutedStems: [] })?.id).toBe("full");
  });
});
