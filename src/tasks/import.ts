import { appUrl } from "../paths";
import { requestRender, state } from "../state";
import { replaceSource, saveProject } from "../storage";
import { newProject } from "../types";

/** File extensions accepted as audio, besides any `audio/*` type. */
export const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".webm",
];

/** The file input's `accept` value. */
export const AUDIO_ACCEPT = ["audio/*", ...AUDIO_EXTENSIONS].join(",");

export function isAudioFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("audio/")) return true;
  const name = file.name.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** A project name from a file name: without its extension, or a default. */
export function projectNameFor(fileName: string): string {
  const base = fileName.replace(/\.[^.\/\\]*$/, "").trim();
  return base || "Untitled project";
}

export const NOT_AUDIO_MESSAGE =
  "That file doesn't look like audio. Choose an MP3, WAV, FLAC, M4A, OGG or Opus file.";

/**
 * Creates a project from an audio file and opens it. Used by sharing to the
 * app, opening a file with the installed app and dropping a file on the
 * project list.
 */
export async function importAsNewProject(file: File): Promise<void> {
  if (!isAudioFile(file)) throw new Error(NOT_AUDIO_MESSAGE);
  const project = await saveProject(newProject(projectNameFor(file.name)));
  state.selectedProject = await replaceSource(project, file, file.name);
  localStorage.setItem("osplit-web-last-project", project.id);
  state.screenMessage = "";
  await requestRender();
}

/** Where the service worker keeps a file shared to the app (see sw.js). */
const INBOX_CACHE = "osplit-inbox";

/**
 * Takes the file shared to the app, if the page was opened by a share
 * (`?shared=1`), and removes the query from the address.
 */
export async function takeSharedFile(): Promise<File | null> {
  const url = new URL(location.href);
  if (!url.searchParams.has("shared")) return null;
  url.searchParams.delete("shared");
  history.replaceState(null, "", url);
  if (!("caches" in window)) return null;
  const cache = await caches.open(INBOX_CACHE);
  const key = appUrl("inbox");
  const response = await cache.match(key);
  if (!response) return null;
  await cache.delete(key);
  const name = decodeURIComponent(
    response.headers.get("X-File-Name") ?? "shared-audio",
  );
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

interface LaunchParams {
  files: FileSystemFileHandle[];
}

/** Opens files the installed app was launched with ("Open with OSplit"). */
export function installLaunchQueue(onFile: (file: File) => void): void {
  const queue = (window as Window & {
    launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
  }).launchQueue;
  queue?.setConsumer(async (params) => {
    const handle = params.files[0];
    if (handle) onFile(await handle.getFile());
  });
}
