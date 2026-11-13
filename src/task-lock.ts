/**
 * One lock per project, held for as long as a separation or URL download runs.
 * Other tabs can then tell a task that is still running elsewhere from one
 * that died with its tab.
 */

export function taskLockName(projectId: string): string {
  return `osplit-task:${projectId}`;
}

export class ProjectBusyError extends Error {
  constructor() {
    super("This project is busy in another OSplit tab or window.");
    this.name = "ProjectBusyError";
  }
}

/** Runs `task` while holding the project's lock; fails if another tab holds it. */
export function withTaskLock<T>(
  projectId: string,
  task: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks) return task();
  return navigator.locks.request(
    taskLockName(projectId),
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new ProjectBusyError();
      return task();
    },
  );
}

/**
 * Names of the task locks currently held in any tab of this origin, or null
 * when the browser cannot tell (no Web Locks API).
 */
export async function heldTaskLocks(): Promise<Set<string> | null> {
  if (!navigator.locks?.query) return null;
  try {
    const snapshot = await navigator.locks.query();
    return new Set(
      (snapshot.held ?? []).flatMap((lock) => lock.name ? [lock.name] : []),
    );
  } catch {
    return null;
  }
}
