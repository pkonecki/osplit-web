import { describe, expect, it } from "vitest";
import {
  matchesFilter,
  matchesQuery,
  projectKind,
  relativeTime,
  sortProjects,
} from "./library";
import { newProject, type Project } from "./types";

function project(name: string, changes: Partial<Project> = {}): Project {
  return { ...newProject(name), ...changes };
}

describe("library", () => {
  it("lists the most recently opened first, then by creation", () => {
    const a = project("A", { createdAt: 100 });
    const b = project("B", { createdAt: 200 });
    const c = project("C", { createdAt: 300 });
    expect(sortProjects([a, b, c], {}).map((p) => p.name)).toEqual(["C", "B", "A"]);
    expect(sortProjects([a, b, c], { [a.id]: 1000 }).map((p) => p.name)).toEqual(["A", "C", "B"]);
  });

  it("tells ready, running, unfinished and empty projects apart", () => {
    expect(projectKind(project("x", { completedStems: ["vocals"], status: "ready" }))).toBe("ready");
    expect(projectKind(project("x", { status: "processing" }))).toBe("busy");
    expect(projectKind(project("x", { status: "interrupted" }))).toBe("interrupted");
    expect(projectKind(project("x", { status: "failed" }))).toBe("failed");
    expect(projectKind(project("x"))).toBe("empty");
    // Audio added but not separated yet.
    expect(projectKind(project("x", { status: "ready", sourceName: "a.wav" }))).toBe("empty");
  });

  it("filters ready and unfinished projects", () => {
    expect(matchesFilter("ready", "all")).toBe(true);
    expect(matchesFilter("ready", "ready")).toBe(true);
    expect(matchesFilter("busy", "ready")).toBe(false);
    expect(matchesFilter("interrupted", "unfinished")).toBe(true);
    expect(matchesFilter("ready", "unfinished")).toBe(false);
  });

  it("searches every word, ignoring case and accents", () => {
    expect(matchesQuery("Café del Mar · cafe.mp3", "cafe")).toBe(true);
    expect(matchesQuery("Midnight Drive · midnight.flac", "DRIVE mid")).toBe(true);
    expect(matchesQuery("Midnight Drive", "drive day")).toBe(false);
    expect(matchesQuery("Anything", "  ")).toBe(true);
  });

  it("says how long ago, briefly", () => {
    const now = 10 * 24 * 3600_000;
    expect(relativeTime(now - 20_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 2 * 3600_000, now)).toBe("2 h ago");
    expect(relativeTime(now - 26 * 3600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 24 * 3600_000, now)).toBe("3 days ago");
  });
});
