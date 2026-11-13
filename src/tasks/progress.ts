import { showMessage, state } from "../state";
import { updateProjectTask } from "../storage";
import { describeError } from "../view/format";

const PROGRESS_SAVE_INTERVAL_MS = 1000;

/**
 * Saves task progress at most once per interval, in order. Await `settled()`
 * before writing the task's final state so a late progress write cannot
 * overwrite it.
 */
export function progressPersister(projectId: string): {
  report(progress: number, stage: string): void;
  settled(): Promise<void>;
} {
  let lastSave = -Infinity;
  let pending: Promise<void> = Promise.resolve();
  return {
    report(progress, stage) {
      const now = performance.now();
      if (now - lastSave < PROGRESS_SAVE_INTERVAL_MS) return;
      lastSave = now;
      pending = pending.then(async () => {
        try {
          const updated = await updateProjectTask(projectId, {
            status: "processing",
            taskProgress: progress,
            taskStage: stage,
          });
          if (state.selectedProject?.id === updated.id) {
            state.selectedProject = updated;
          }
        } catch (error) {
          showMessage(`Could not save task progress: ${describeError(error)}`);
        }
      });
    },
    settled: () => pending,
  };
}
