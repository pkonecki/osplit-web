/**
 * A cloud storage folder the app syncs projects to: the app's own folder in
 * the user's Dropbox or OneDrive. Paths are relative to that folder and use
 * "/" between parts, which are plain ASCII names (project ids, hashes).
 */
export interface CloudEntry {
  name: string;
  folder: boolean;
  size: number;
}

export interface CloudStore {
  /** The entries directly in a folder; empty if it doesn't exist. */
  list(folder: string): Promise<CloudEntry[]>;
  /** The file at a path, or null if there is none. */
  read(path: string): Promise<Blob | null>;
  /**
   * Writes a file, replacing any file at that path and creating the folders
   * it is in. `progress` gets the bytes sent so far.
   */
  write(path: string, data: Blob, progress?: (sent: number) => void): Promise<void>;
  /** Removes a file or a folder with all it holds; nothing if it is gone. */
  remove(path: string): Promise<void>;
  /** The account's storage: bytes used and in all; null if unknown. */
  quota?(): Promise<CloudQuota | null>;
}

export interface CloudQuota {
  used: number;
  total: number;
}

/** An error for a failed request, with the service's own message if any. */
export async function requestError(service: string, response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = await response.clone().json() as Record<string, any>;
    detail = body.error_summary ?? body.error?.message ?? body.error_description ?? "";
  } catch {
    // Not JSON: the status says enough.
  }
  return new Error(
    `${service} request failed (${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}).`,
  );
}

/** Calls `step` for each chunk of `data` in order, with its start offset. */
export async function forEachChunk(
  data: Blob,
  chunkSize: number,
  step: (chunk: Blob, start: number, last: boolean) => Promise<void>,
): Promise<void> {
  let start = 0;
  do {
    const end = Math.min(start + chunkSize, data.size);
    await step(data.slice(start, end), start, end >= data.size);
    start = end;
  } while (start < data.size);
}
