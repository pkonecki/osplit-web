import { isQuotaError } from "../storage";
import type { ProjectStatus } from "../types";

export function statusLabel(status: ProjectStatus): string {
  return {
    empty: "Empty project",
    ready: "Ready",
    processing: "Processing",
    interrupted: "Interrupted",
    failed: "Failed",
  }[status];
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`
    : `${m}:${s}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 100) || "osplit";
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]!);
}

export function describeError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : "Something went wrong.";
  if (isQuotaError(error)) {
    return "Browser storage is full. Delete projects or cached data, then try again.";
  }
  return message;
}

/**
 * A worker's uncaught error (often the browser killing it for memory) reaches
 * the page as a bare ErrorEvent whose message is useless to show, such as
 * "Uncaught [object ErrorEvent]". Log the details and show a plain message.
 */
export function workerCrash(event: ErrorEvent, message: string): Error {
  console.error(message, event.message, event.error ?? event);
  return new Error(message);
}
