import type { UrlResponse } from "../messages";
import { requestRender, setMessageText, state } from "../state";
import { replaceSource, updateProjectTask } from "../storage";
import type { Project } from "../types";
import { describeError, workerCrash } from "../view/format";
import { progressPersister } from "./progress";
import { acquireWakeLock, releaseWakeLock } from "./wake-lock";

let urlWorker: Worker | undefined;
let rejectUrlDownload: ((error: Error) => void) | undefined;

/** Whether a URL download or yt-dlp update runs in this tab. */
export function urlTaskActive(): boolean {
  return urlWorker !== undefined;
}

export function cancelUrlDownload(): void {
  if (!state.working || !urlWorker) return;
  urlWorker.terminate();
  rejectUrlDownload?.(new DOMException("Download cancelled.", "AbortError"));
}

export function terminateUrlWorker(): void {
  urlWorker?.terminate();
}

export async function downloadFromUrl(project: Project): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#media-url");
  const url = input?.value.trim();
  if (!url) throw new Error("Enter a media URL.");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Enter a valid http or https URL.");
  }
  if (state.working) return;
  state.working = true;
  state.screenMessage = "Starting browser URL downloader…";
  const persist = progressPersister(project.id);
  const id = crypto.randomUUID();
  const worker = new Worker(new URL("../url.worker.ts", import.meta.url), {
    type: "module",
  });
  urlWorker = worker;
  acquireWakeLock();
  try {
    state.selectedProject = await updateProjectTask(project.id, {
      status: "processing",
      taskProgress: 0,
      taskStage: "Starting browser URL downloader",
      errorMessage: null,
    });
    await requestRender();
    const downloaded = await new Promise<{ name: string; blob: Blob }>(
      (resolve, reject) => {
        rejectUrlDownload = reject;
        worker.onmessage = (event: MessageEvent<UrlResponse>) => {
          const message = event.data;
          if (message.id !== id) return;
          if (message.type === "progress") {
            persist.report(message.progress, message.stage);
            setMessageText(`${message.stage} · ${message.progress}%`);
          } else if (message.type === "downloaded") {
            resolve({ name: message.name, blob: message.blob });
          } else if (message.type === "updated") {
            reject(new Error("Unexpected update response during download."));
          } else {
            reject(new Error(message.message));
          }
        };
        worker.onerror = (event) =>
          reject(
            workerCrash(event, "The URL download stopped unexpectedly."),
          );
        worker.postMessage({ type: "download", id, url });
      },
    );
    await persist.settled();
    state.selectedProject = await replaceSource(
      project,
      downloaded.blob,
      downloaded.name,
    );
    state.screenMessage = "";
  } catch (error) {
    const cancelled = error instanceof DOMException &&
      error.name === "AbortError";
    await persist.settled();
    state.selectedProject = await updateProjectTask(project.id, {
      status: cancelled ? "interrupted" : "failed",
      taskStage: cancelled ? "Download cancelled" : "Download failed",
      errorMessage: cancelled
        ? "Download was cancelled. Retry when ready."
        : describeError(error),
    });
    throw error;
  } finally {
    worker.terminate();
    urlWorker = undefined;
    rejectUrlDownload = undefined;
    state.working = false;
    releaseWakeLock();
    await requestRender();
  }
}

export async function checkYtDlpUpdate(): Promise<void> {
  if (state.working) return;
  state.working = true;
  state.screenMessage = "Checking yt-dlp…";
  await requestRender();
  const worker = new Worker(new URL("../url.worker.ts", import.meta.url), {
    type: "module",
  });
  urlWorker = worker;
  const id = crypto.randomUUID();
  try {
    const version = await new Promise<string>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<UrlResponse>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          setMessageText(`${message.stage} · ${message.progress}%`);
        } else if (message.type === "updated") {
          resolve(message.version);
        } else if (message.type === "error") {
          reject(new Error(message.message));
        }
      };
      worker.onerror = (event) =>
        reject(workerCrash(event, "The yt-dlp update stopped unexpectedly."));
      worker.postMessage({
        type: "update",
        id,
        installedVersion: localStorage.getItem("osplit-web-ytdlp-version"),
      });
    });
    localStorage.setItem("osplit-web-ytdlp-version", version);
    state.screenMessage = `yt-dlp ${version} is ready for browser URL downloads.`;
  } finally {
    worker.terminate();
    urlWorker = undefined;
    state.working = false;
    await requestRender();
  }
}
