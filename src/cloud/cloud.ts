import { getProject, listProjects, readProjectData, storageEstimate, writeProjectData } from "../storage";
import { formatBytes } from "../view/format";
import { DAMAGED } from "../project-file";
import { DropboxStore, dropboxConfig } from "./dropbox";
import {
  authorizedFetcher,
  exchangeCode,
  type OAuthConfig,
  type ProviderId,
  ReconnectNeeded,
  signInUrl,
  takePendingSignIn,
  type Tokens,
} from "./oauth";
import { OneDriveStore, oneDriveConfig } from "./onedrive";
import {
  downloadProject,
  listRemoteProjects,
  planSync,
  type RemoteProject,
  removeRemoteProject,
  uploadProject,
} from "./sync";

/**
 * Optional cloud sync of projects to the user's own Dropbox or OneDrive.
 * Each deployment registers its own app with the provider and builds with
 * its id (VITE_DROPBOX_APP_KEY, VITE_ONEDRIVE_CLIENT_ID); without one the
 * provider isn't offered, and without both the feature is hidden.
 */

export type { ProviderId };

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  dropbox: "Dropbox",
  onedrive: "OneDrive",
};

const CONNECTION_KEY = "osplit-cloud-connection";
const AUTO_SYNC_KEY = "osplit-cloud-auto-sync";

interface Connection {
  provider: ProviderId;
  account: string;
  tokens: Tokens;
}

function env(name: string): string {
  const value = (import.meta.env as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

function configFor(provider: ProviderId): OAuthConfig | null {
  if (provider === "dropbox") {
    const key = env("VITE_DROPBOX_APP_KEY");
    return key ? dropboxConfig(key) : null;
  }
  const id = env("VITE_ONEDRIVE_CLIENT_ID");
  return id ? oneDriveConfig(id, env("VITE_ONEDRIVE_TENANT") || "common") : null;
}

/** The providers this build can connect to. */
export function availableProviders(): ProviderId[] {
  return (["dropbox", "onedrive"] as const).filter((id) => configFor(id) !== null);
}

/** What the cloud panel shows; updated by syncs. */
export const cloud = {
  busy: false,
  /** The sign-in expired: syncing needs the user to sign in again. */
  needsReconnect: false,
  /** Progress or the outcome of the last sync. */
  status: "",
  /** The cloud's projects as of the last sync, by id; null before one. */
  remote: null as Map<string, RemoteProject> | null,
};

function loadConnection(): Connection | null {
  try {
    const value = JSON.parse(localStorage.getItem(CONNECTION_KEY) ?? "null") as Connection | null;
    if (!value || !configFor(value.provider) || typeof value.tokens?.accessToken !== "string") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function saveConnection(connection: Connection): void {
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
}

/** The connected provider and account, if any. */
export function connection(): { provider: ProviderId; label: string; account: string } | null {
  const value = loadConnection();
  return value && {
    provider: value.provider,
    label: PROVIDER_LABELS[value.provider],
    account: value.account,
  };
}

export function autoSync(): boolean {
  return localStorage.getItem(AUTO_SYNC_KEY) !== "off";
}

export function setAutoSync(on: boolean): void {
  localStorage.setItem(AUTO_SYNC_KEY, on ? "on" : "off");
}

/** The page the provider sends the user back to; registered with the app. */
function redirectUri(): string {
  return `${location.origin}${import.meta.env.BASE_URL}`;
}

function exclusive(run: () => Promise<Tokens>): Promise<Tokens> {
  return navigator.locks
    ? navigator.locks.request("osplit-cloud-token", run) as Promise<Tokens>
    : run();
}

function storeFor(provider: ProviderId): DropboxStore | OneDriveStore {
  const config = configFor(provider);
  if (!config) throw new Error(`${PROVIDER_LABELS[provider]} isn't available in this build.`);
  const fetcher = authorizedFetcher(
    config,
    () => {
      const current = loadConnection();
      if (!current || current.provider !== provider) throw new ReconnectNeeded();
      return current.tokens;
    },
    (tokens) => {
      const current = loadConnection();
      if (current?.provider === provider) saveConnection({ ...current, tokens });
    },
    { exclusive },
  );
  return provider === "dropbox" ? new DropboxStore(fetcher) : new OneDriveStore(fetcher);
}

function connectedStore(): { store: DropboxStore | OneDriveStore; label: string } {
  const current = loadConnection();
  if (!current) throw new Error("Connect a cloud storage account first.");
  return { store: storeFor(current.provider), label: PROVIDER_LABELS[current.provider] };
}

/** Leaves for the provider's sign-in page; it sends the user back here. */
export async function connect(provider: ProviderId): Promise<void> {
  const config = configFor(provider);
  if (!config) throw new Error(`${PROVIDER_LABELS[provider]} isn't available in this build.`);
  location.assign(await signInUrl(config, redirectUri(), sessionStorage));
}

/**
 * Completes a sign-in when the provider sent the user back to the app.
 * Returns the message to show, or null if the page wasn't opened that way.
 */
export async function finishSignIn(): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  if (!params.has("state") || !(params.has("code") || params.has("error"))) return null;
  const pending = takePendingSignIn(params, sessionStorage);
  const url = new URL(location.href);
  for (const key of ["code", "state", "error", "error_description", "scope", "session_state"]) {
    url.searchParams.delete(key);
  }
  history.replaceState(null, "", url);
  if (!pending) return "The sign-in didn't come from this tab. Connect again.";
  const label = PROVIDER_LABELS[pending.provider];
  const config = configFor(pending.provider);
  if (!config) return null;
  const error = params.get("error");
  if (error) {
    return error === "access_denied"
      ? `Connecting to ${label} was cancelled.`
      : `Couldn't connect to ${label}: ${(params.get("error_description") ?? error).slice(0, 200)}`;
  }
  let tokens: Tokens;
  try {
    tokens = await exchangeCode(config, params.get("code") ?? "", pending.verifier, redirectUri());
  } catch {
    return `Couldn't connect to ${label}. Try again.`;
  }
  const previous = loadConnection();
  saveConnection({
    provider: pending.provider,
    account: previous?.provider === pending.provider ? previous.account : "",
    tokens,
  });
  if (previous?.provider !== pending.provider) cloud.remote = null;
  cloud.needsReconnect = false;
  cloud.status = "";
  try {
    const account = await storeFor(pending.provider).account();
    const current = loadConnection();
    if (current) saveConnection({ ...current, account });
  } catch (error) {
    console.warn("Could not read the account name.", error);
  }
  return `Connected to ${label}. Projects sync to the app's folder there.`;
}

/** Forgets the connection; projects stay in the cloud. */
export async function disconnect(): Promise<void> {
  const current = loadConnection();
  if (current?.provider === "dropbox") {
    await (storeFor("dropbox") as DropboxStore).revoke().catch(() => {});
  }
  localStorage.removeItem(CONNECTION_KEY);
  cloud.busy = false;
  cloud.needsReconnect = false;
  cloud.status = "";
  cloud.remote = null;
}

function setStatus(text: string): void {
  cloud.status = text;
  const element = document.querySelector<HTMLElement>(".cloud-status");
  if (element) element.textContent = text;
}

function percent(done: number, total: number): string {
  return total ? ` ${Math.floor((done / total) * 100)}%` : "";
}

async function checkSpace(bytes: number): Promise<void> {
  const estimate = await storageEstimate();
  if (estimate?.quota && estimate.usage !== undefined && bytes > estimate.quota - estimate.usage) {
    throw new Error(
      `Not enough browser storage to download this project (${formatBytes(bytes)}). Delete projects, then try again.`,
    );
  }
}

function cloudMessage(error: unknown, label: string): string {
  if (error instanceof ReconnectNeeded) {
    return `Your ${label} sign-in expired. Sign in again to keep syncing.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message === DAMAGED
    ? `The copy in ${label} is damaged. Sync again from the device that has the project.`
    : message;
}

export interface SyncHooks {
  /** Called before a project's data is replaced by a download. */
  replacing(projectId: string): void;
}

/**
 * Syncs the projects with the cloud: uploads projects changed here, updates
 * projects changed elsewhere, and lists projects only in the cloud. Returns
 * a summary.
 */
export async function syncNow(hooks: SyncHooks): Promise<string> {
  if (cloud.busy) return "A sync is already running.";
  const { store, label } = connectedStore();
  cloud.busy = true;
  try {
    setStatus(`Checking ${label}…`);
    const remote = await listRemoteProjects(store);
    const plan = planSync(await listProjects(), remote);
    const byId = new Map(remote.map((project) => [project.id, project]));
    const failed: string[] = [];
    let firstError = "";
    const attempt = async (name: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        if (error instanceof ReconnectNeeded) throw error;
        console.warn(`Cloud sync of "${name}" failed.`, error);
        failed.push(name);
        firstError ||= cloudMessage(error, label);
      }
    };
    let uploaded = 0;
    for (const project of plan.upload) {
      await attempt(project.name, async () => {
        const data = await readProjectData(project.id);
        if (!data || data.project.status === "processing") return;
        setStatus(`Uploading "${data.project.name}" to ${label}…`);
        const copy = await uploadProject(store, data, (done, total) =>
          setStatus(`Uploading "${data.project.name}" to ${label}…${percent(done, total)}`));
        byId.set(copy.id, copy);
        uploaded++;
      });
    }
    let downloaded = 0;
    for (const copy of plan.download) {
      await attempt(copy.name, async () => {
        const local = await readProjectData(copy.id);
        if (local?.project.status === "processing") return;
        const data = await downloadProject(store, copy.id, local, (done, total) =>
          setStatus(`Updating "${copy.name}" from ${label}…${percent(done, total)}`));
        if ((await getProject(copy.id))?.status === "processing") return;
        hooks.replacing(copy.id);
        await writeProjectData(data, { keepUpdatedAt: true });
        downloaded++;
      });
    }
    cloud.remote = byId;
    cloud.needsReconnect = false;
    const parts = [];
    if (uploaded) parts.push(`${uploaded} uploaded`);
    if (downloaded) parts.push(`${downloaded} updated from ${label}`);
    let summary = parts.length ? `Synced with ${label}: ${parts.join(", ")}.` : `Up to date with ${label}.`;
    if (failed.length) summary += ` Couldn't sync ${failed.map((name) => `"${name}"`).join(", ")}: ${firstError}`;
    setStatus(summary);
    return summary;
  } catch (error) {
    if (error instanceof ReconnectNeeded) cloud.needsReconnect = true;
    const message = cloudMessage(error, label);
    setStatus(message);
    throw new Error(message);
  } finally {
    cloud.busy = false;
  }
}

/** Projects in the cloud that aren't on this device, newest first. */
export async function remoteOnlyProjects(): Promise<RemoteProject[]> {
  if (!cloud.remote) return [];
  const local = new Set((await listProjects()).map((project) => project.id));
  return [...cloud.remote.values()]
    .filter((project) => !local.has(project.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Downloads a project that is only in the cloud. Returns its name. */
export async function downloadRemote(id: string, hooks: SyncHooks): Promise<string> {
  if (cloud.busy) throw new Error("Wait for the sync to finish.");
  const { store, label } = connectedStore();
  const copy = cloud.remote?.get(id);
  if (!copy) throw new Error("That project is no longer in the cloud. Sync again.");
  cloud.busy = true;
  try {
    const local = await readProjectData(id);
    if (local?.project.status === "processing") {
      throw new Error("That project is being processed on this device.");
    }
    if (!local) await checkSpace(copy.size);
    const data = await downloadProject(store, id, local, (done, total) =>
      setStatus(`Downloading "${copy.name}" from ${label}…${percent(done, total)}`));
    hooks.replacing(id);
    await writeProjectData(data, { keepUpdatedAt: true });
    setStatus(`Downloaded "${copy.name}".`);
    return copy.name;
  } catch (error) {
    if (error instanceof ReconnectNeeded) cloud.needsReconnect = true;
    const message = cloudMessage(error, label);
    setStatus(message);
    throw new Error(message);
  } finally {
    cloud.busy = false;
  }
}

/** Removes a project from the cloud (this device's copy stays). */
export async function removeRemote(id: string): Promise<void> {
  if (cloud.busy) throw new Error("Wait for the sync to finish.");
  const { store, label } = connectedStore();
  cloud.busy = true;
  try {
    await removeRemoteProject(store, id);
    cloud.remote?.delete(id);
  } catch (error) {
    if (error instanceof ReconnectNeeded) cloud.needsReconnect = true;
    throw new Error(cloudMessage(error, label));
  } finally {
    cloud.busy = false;
  }
}

/** True if the last sync saw this project in the cloud. */
export function inCloud(id: string): boolean {
  return cloud.remote?.has(id) ?? false;
}

/** The project's sync state as of the last sync, for its card. */
export function cloudState(id: string, updatedAt: number): "synced" | "changed" | "local" | null {
  if (!cloud.remote || !loadConnection()) return null;
  const copy = cloud.remote.get(id);
  if (!copy) return "local";
  return copy.updatedAt === updatedAt ? "synced" : "changed";
}
