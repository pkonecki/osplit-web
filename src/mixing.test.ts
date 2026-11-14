import { describe, expect, it } from "vitest";
import { soloStems, stemVolume, toggleStem } from "./mixing";
import { newProject, type Project } from "./types";

function project(changes: Partial<Project> = {}): Project {
  return {
    ...newProject("mix"),
    volumes: { vocals: 0.8, piano: 0.5, drums: 1, bass: 0.3, other: 0.6 },
    ...changes,
  };
}

describe("stem volume rule", () => {
  it("uses each stem's volume when nothing is muted or soloed", () => {
    expect(stemVolume(project(), "vocals")).toBe(0.8);
    expect(stemVolume(project(), "bass")).toBe(0.3);
  });

  it("silences muted stems", () => {
    const muted = project({ mutedStems: ["drums"] });
    expect(stemVolume(muted, "drums")).toBe(0);
    expect(stemVolume(muted, "vocals")).toBe(0.8);
  });

  it("plays only soloed stems while any stem is soloed", () => {
    const soloed = project({ soloStems: ["vocals", "bass"] });
    expect(stemVolume(soloed, "vocals")).toBe(0.8);
    expect(stemVolume(soloed, "bass")).toBe(0.3);
    expect(stemVolume(soloed, "drums")).toBe(0);
    expect(stemVolume(soloed, "piano")).toBe(0);
  });

  it("keeps a soloed stem silent if it is also muted", () => {
    const both = project({ soloStems: ["vocals"], mutedStems: ["vocals"] });
    expect(stemVolume(both, "vocals")).toBe(0);
    expect(stemVolume(both, "drums")).toBe(0);
  });

  it("treats projects saved before solo existed as having no solo", () => {
    const old = project();
    delete (old as Partial<Project>).soloStems;
    expect(soloStems(old)).toEqual([]);
    expect(stemVolume(old, "piano")).toBe(0.5);
  });

  it("toggles a stem in and out of a list", () => {
    expect(toggleStem([], "drums")).toEqual(["drums"]);
    expect(toggleStem(["drums", "bass"], "drums")).toEqual(["bass"]);
  });
});
