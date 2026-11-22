import type { Fetcher, OAuthConfig } from "./oauth";
import { type CloudEntry, type CloudStore, forEachChunk, requestError } from "./store";

/**
 * Dropbox, through an app with "App folder" access: the app sees only
 * /Apps/<app name>/ in the user's Dropbox, and its paths start there.
 * https://www.dropbox.com/developers/documentation/http/documentation
 */

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
/** Files up to this size go in one request; larger ones in chunks of it. */
export const DROPBOX_CHUNK = 8 * 1024 * 1024;

export function dropboxConfig(clientId: string): OAuthConfig {
  return {
    id: "dropbox",
    clientId,
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    // The scopes are the ones enabled in the app's settings.
    authorizeParams: { token_access_type: "offline" },
  };
}

/**
 * The Dropbox-API-Arg header value: JSON with non-ASCII characters escaped,
 * since HTTP headers carry ASCII only.
 */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function dropboxPath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

/** True for the 409 error Dropbox sends for a path with nothing at it. */
async function notFound(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const body = await response.clone().json() as { error_summary?: string };
    return /not_found/.test(body.error_summary ?? "");
  } catch {
    return false;
  }
}

export class DropboxStore implements CloudStore {
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
  }

  private async rpc(endpoint: string, args: unknown): Promise<Response> {
    return this.fetcher(`${API}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  }

  async list(folder: string): Promise<CloudEntry[]> {
    const entries: CloudEntry[] = [];
    let response = await this.rpc("files/list_folder", { path: dropboxPath(folder), limit: 2000 });
    for (;;) {
      if (await notFound(response)) return [];
      if (!response.ok) throw await requestError("Dropbox", response);
      const page = await response.json() as {
        entries: { ".tag": string; name: string; size?: number }[];
        cursor: string;
        has_more: boolean;
      };
      for (const entry of page.entries) {
        if (entry[".tag"] === "deleted") continue;
        entries.push({ name: entry.name, folder: entry[".tag"] === "folder", size: entry.size ?? 0 });
      }
      if (!page.has_more) return entries;
      response = await this.rpc("files/list_folder/continue", { cursor: page.cursor });
    }
  }

  async read(path: string): Promise<Blob | null> {
    const response = await this.fetcher(`${CONTENT}/files/download`, {
      method: "POST",
      headers: { "Dropbox-API-Arg": apiArg({ path: dropboxPath(path) }) },
    });
    if (await notFound(response)) return null;
    if (!response.ok) throw await requestError("Dropbox", response);
    return response.blob();
  }

  async write(path: string, data: Blob, progress?: (sent: number) => void): Promise<void> {
    const commit = { path: dropboxPath(path), mode: "overwrite", mute: true };
    const upload = async (endpoint: string, arg: unknown, body: Blob): Promise<Response> => {
      const response = await this.fetcher(`${CONTENT}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": apiArg(arg),
        },
        body,
      });
      if (!response.ok) throw await requestError("Dropbox", response);
      return response;
    };
    if (data.size <= DROPBOX_CHUNK) {
      await upload("files/upload", commit, data);
      progress?.(data.size);
      return;
    }
    // Larger files go in an upload session, a chunk per request.
    let sessionId = "";
    await forEachChunk(data, DROPBOX_CHUNK, async (chunk, offset, last) => {
      if (offset === 0) {
        const response = await upload("files/upload_session/start", { close: false }, chunk);
        sessionId = (await response.json() as { session_id: string }).session_id;
      } else if (last) {
        await upload("files/upload_session/finish", {
          cursor: { session_id: sessionId, offset },
          commit,
        }, chunk);
      } else {
        await upload("files/upload_session/append_v2", {
          cursor: { session_id: sessionId, offset },
          close: false,
        }, chunk);
      }
      progress?.(offset + chunk.size);
    });
  }

  async remove(path: string): Promise<void> {
    const response = await this.rpc("files/delete_v2", { path: dropboxPath(path) });
    if (await notFound(response)) return;
    if (!response.ok) throw await requestError("Dropbox", response);
  }

  /** The signed-in user's name, to show which account is connected. */
  async account(): Promise<string> {
    const response = await this.fetcher(`${API}/users/get_current_account`, { method: "POST" });
    if (!response.ok) throw await requestError("Dropbox", response);
    const body = await response.json() as { name?: { display_name?: string }; email?: string };
    return body.name?.display_name ?? body.email ?? "";
  }

  /** Revokes the access token, on disconnect. */
  async revoke(): Promise<void> {
    await this.fetcher(`${API}/auth/token/revoke`, { method: "POST" });
  }
}
