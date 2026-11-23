import type { Project } from "./types";

/**
 * The library's order, search and filters. Pure functions over projects,
 * plus when each project was last opened on this device (kept in
 * localStorage: it is not part of the project, so it does not sync).
 */

const OPENED_KEY = "osplit-web-opened";

/** Last time each project was opened here, by id (ms since the epoch). */
export function openedTimes(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, number> : {};
  } catch {
    return {};
  }
}

export function markOpened(id: string, now = Date.now()): void {
  try {
    const times = openedTimes();
    times[id] = now;
    localStorage.setItem(OPENED_KEY, JSON.stringify(times));
  } catch {
    // Not saved: the order falls back to when projects were created.
  }
}

export function forgetOpened(id: string): void {
  try {
    const times = openedTimes();
    delete times[id];
    localStorage.setItem(OPENED_KEY, JSON.stringify(times));
  } catch {
    // Nothing to forget.
  }
}

/** Most recently opened first; never-opened projects by when they were made. */
export function sortProjects(
  projects: readonly Project[],
  opened: Record<string, number>,
): Project[] {
  const when = (project: Project) => Math.max(opened[project.id] ?? 0, project.createdAt);
  return [...projects].sort((a, b) => when(b) - when(a) || a.name.localeCompare(b.name));
}

/** What a library row shows about a project's state. */
export type ProjectKind = "ready" | "busy" | "interrupted" | "failed" | "empty";

export function projectKind(project: Project): ProjectKind {
  if (project.status === "processing") return "busy";
  if (project.status === "failed") return "failed";
  if (project.status === "interrupted") return "interrupted";
  if (project.completedStems.length > 0) return "ready";
  return "empty";
}

export type LibraryFilter = "all" | "ready" | "unfinished";

export const LIBRARY_FILTERS: { id: LibraryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "unfinished", label: "Unfinished" },
];

export function matchesFilter(kind: ProjectKind, filter: LibraryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return kind === "ready";
  return kind !== "ready";
}

/** Case- and accent-insensitive match of every word of `query` in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const fold = (value: string) =>
    value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const haystack = fold(text);
  return fold(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", or a date. */
export function relativeTime(then: number, now = Date.now()): string {
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
