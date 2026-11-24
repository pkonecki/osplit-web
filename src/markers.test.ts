import { describe, expect, it } from "vitest";
import type { ChartBar } from "./analysis/chart";
import {
  addMarker,
  markerIndexAtBar,
  removeMarker,
  renameMarker,
  sectionBars,
  sectionLoop,
  snapMarkers,
  stepMarker,
} from "./markers";

/** Bars of 2 s from bar 1 at 0 s. */
function bars(count: number, length = 2): ChartBar[] {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    beat: i * 4,
    start: i * length,
    end: (i + 1) * length,
    chords: ["C"],
  }));
}

const marker = (bar: number, name: string) => ({ bar, time: (bar - 1) * 2, name });

describe("markers", () => {
  it("keeps markers sorted, one per bar", () => {
    let list = addMarker([], marker(9, "Chorus"));
    list = addMarker(list, marker(1, "Intro"));
    list = addMarker(list, marker(5, "  Verse   1 "));
    expect(list.map((item) => [item.bar, item.name])).toEqual([[1, "Intro"], [5, "Verse 1"], [9, "Chorus"]]);
    list = addMarker(list, marker(5, "Verse"));
    expect(list.map((item) => item.name)).toEqual(["Intro", "Verse", "Chorus"]);
    expect(addMarker([], marker(2, "  ")).at(0)?.name).toBe("Marker");
  });

  it("renames and deletes", () => {
    const list = [marker(1, "Intro"), marker(5, "Verse")];
    expect(renameMarker(list, 5, "Verse 1")[1].name).toBe("Verse 1");
    expect(renameMarker(list, 5, " ")[1].name).toBe("Verse");
    expect(removeMarker(list, 1)).toEqual([marker(5, "Verse")]);
  });

  it("runs a section to the bar before the next marker, or the end", () => {
    const list = [marker(1, "Intro"), marker(5, "Verse"), marker(9, "Chorus")];
    expect(sectionBars(list, 0, 16)).toEqual({ first: 1, last: 4 });
    expect(sectionBars(list, 2, 16)).toEqual({ first: 9, last: 16 });
    expect(sectionLoop(list, 1, bars(16))).toEqual({ start: 8, end: 16 });
    expect(sectionLoop(list, 2, bars(16))).toEqual({ start: 16, end: 32 });
  });

  it("finds the section of a bar and steps between markers", () => {
    const list = [marker(5, "Verse"), marker(9, "Chorus")];
    expect(markerIndexAtBar(list, 3)).toBe(-1);
    expect(markerIndexAtBar(list, 7)).toBe(0);
    expect(markerIndexAtBar(list, 12)).toBe(1);
    expect(stepMarker(list, 6, 1, false)?.name).toBe("Chorus");
    expect(stepMarker(list, 9, -1, true)?.name).toBe("Verse");
    // Inside a section, back goes to its own start first.
    expect(stepMarker(list, 9, -1, false)?.name).toBe("Chorus");
    expect(stepMarker(list, 12, 1, false)).toBeNull();
  });

  it("follows the music when the grid changes", () => {
    const list = [marker(5, "Verse"), marker(9, "Chorus")];
    // Same grid: nothing moves.
    expect(snapMarkers(list, bars(16))).toBe(list);
    // Tempo ×2: bars are 1 s, so 8 s is bar 9 and 16 s bar 17.
    expect(snapMarkers(list, bars(32, 1)).map((item) => item.bar)).toEqual([9, 17]);
    // Bar 1 a beat later: bars start 0.5 s later; the nearest bar stays.
    const shifted = bars(16).map((bar) => ({ ...bar, start: bar.start + 0.5, end: bar.end + 0.5 }));
    expect(snapMarkers(list, shifted).map((item) => item.bar)).toEqual([5, 9]);
    // Two markers on one bar keep the first.
    expect(snapMarkers([marker(5, "A"), { bar: 6, time: 8.4, name: "B" }], bars(16))).toHaveLength(1);
  });
});
