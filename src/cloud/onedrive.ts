import { type Fetcher, type OAuthConfig, withRetry } from "./oauth";
import { type CloudEntry, type CloudStore, forEachChunk, requestError } from "./store";

/**
 * OneDrive, through Microsoft Graph with the Files.ReadWrite.AppFolder
 * permission: the app sees only its own folder (Apps/<app name>/), the
 * drive's "approot".
 * https://learn.microsoft.com/graph/api/resources/onedrive
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const APPROOT = `${GRAPH}/me/drive/special/approot`;
/** Files up to 4 MB go in one request; larger ones in an upload session. */
export const ONEDRIVE_SIMPLE_LIMIT = 4 * 1024 * 1024;
/** Upload session chunks must be multiples of 320 KiB: this is 10 MiB. */
export const ONEDRIVE_CHUNK = 32 * 320 * 1024;

export function oneDriveConfig(clientId: string, tenant = "common"): OAuthConfig {
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  return {
    id: "onedrive",
    clientId,
    authorizeUrl: `${authority}/authorize`,
    tokenUrl: `${authority}/token`,
    scope: "Files.ReadWrite.AppFolder offline_access",
  };
}

function encodePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").split("/").map(encodeURIComponent).join("/");
}

/** The URL of the item at a path in the app folder. */
function itemUrl(path: string): string {
  return `${APPROOT}:/${encodePath(path)}`;
}

export class OneDriveStore implements CloudStore {
  private readonly fetcher: Fetcher;
  /** For requests to pre-authenticated URLs, sent without the token. */
  private readonly plainFetch: typeof fetch;

  constructor(fetcher: Fetcher, plainFetch: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetcher = fetcher;
    this.plainFetch = plainFetch;
  }

  async list(folder: string): Promise<CloudEntry[]> {
    const entries: CloudEntry[] = [];
    let url: string | undefined = `${itemUrl(folder)}:/children?$select=name,size,folder&$top=1000`;
    while (url) {
      const response = await this.fetcher(url);
      if (response.status === 404) return [];
      if (!response.ok) throw await requestError("OneDrive", response);
      const page = await response.json() as {
        value: { name: string; size?: number; folder?: unknown }[];
        "@odata.nextLink"?: string;
      };
      for (const item of page.value) {
        entries.push({ name: item.name, folder: item.folder !== undefined, size: item.size ?? 0 });
      }
      url = page["@odata.nextLink"];
    }
    return entries;
  }

  async read(path: string): Promise<Blob | null> {
    // The item's download URL is pre-authenticated and allows cross-origin
    // reads; the /content redirect does not work from a page.
    const response = await this.fetcher(itemUrl(path));
    if (response.status === 404) return null;
    if (!response.ok) throw await requestError("OneDrive", response);
    const item = await response.json() as { "@microsoft.graph.downloadUrl"?: string; folder?: unknown };
    const downloadUrl = item["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) return null;
    const download = await withRetry(() => this.plainFetch(downloadUrl));
    if (!download.ok) throw await requestError("OneDrive", download);
    return download.blob();
  }

  async write(path: string, data: Blob, progress?: (sent: number) => void): Promise<void> {
    if (data.size <= ONEDRIVE_SIMPLE_LIMIT) {
      const response = await this.fetcher(`${itemUrl(path)}:/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
      });
      if (!response.ok) throw await requestError("OneDrive", response);
      progress?.(data.size);
      return;
    }
    const session = await this.fetcher(`${itemUrl(path)}:/createUploadSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    });
    if (!session.ok) throw await requestError("OneDrive", session);
    const { uploadUrl } = await session.json() as { uploadUrl: string };
    // The upload URL carries its own authorization: no token is sent to it.
    await forEachChunk(data, ONEDRIVE_CHUNK, async (chunk, start) => {
      const end = start + chunk.size - 1;
      const response = await withRetry(() =>
        this.plainFetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Range": `bytes ${start}-${end}/${data.size}` },
          body: chunk,
        })
      );
      if (!response.ok) throw await requestError("OneDrive", response);
      progress?.(end + 1);
    });
  }

  async remove(path: string): Promise<void> {
    const response = await this.fetcher(itemUrl(path), { method: "DELETE" });
    if (response.status === 404 || response.ok) return;
    throw await requestError("OneDrive", response);
  }

  /** The drive owner's name, to show which account is connected. */
  async account(): Promise<string> {
    const response = await this.fetcher(`${GRAPH}/me/drive?$select=owner`);
    if (!response.ok) throw await requestError("OneDrive", response);
    const body = await response.json() as { owner?: { user?: { displayName?: string } } };
    return body.owner?.user?.displayName ?? "";
  }
}
