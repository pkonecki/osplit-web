import type { Project } from "./types";

/** App state shared by the views, tasks and event handlers. */
export const state = {
  projects: [] as Project[],
  selectedProject: null as Project | null,
  /** Progress of the running task, 0–100, and its stage label. */
  progress: 0,
  progressLabel: "",
  /** Message shown at the top of the page; empty when none. */
  screenMessage: "",
  /** True while this tab runs a separation, URL download or yt-dlp update. */
  working: false,
  /** What the shared hidden file input was opened for. */
  fileDialogTarget: "none" as "source" | "none",
};

let renderer: () => Promise<void> = async () => {};

/** Called once by main.ts, so other modules can render without importing it. */
export function onRender(render: () => Promise<void>): void {
  renderer = render;
}

/** Re-renders the current view from storage and state. */
export function requestRender(): Promise<void> {
  return renderer();
}

/** Updates the page message in place; returns false if none is shown. */
export function setMessageText(message: string): boolean {
  state.screenMessage = message;
  const element = document.querySelector<HTMLElement>(".message span");
  if (element) element.textContent = message;
  return element !== null;
}

/** Shows `message` in the page message, re-rendering only if none is shown. */
export function showMessage(message: string): void {
  if (!setMessageText(message)) void requestRender();
}
