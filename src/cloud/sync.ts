import {
  checkManifest,
  DAMAGED,
  type Manifest,
  projectParts,
  readProjectParts,
} from "../project-file";
import type { ProjectData } from "../storage";
import type { Project, ProjectStatus } from "../types";
import type { CloudStore } from "./store";

/**
 * Projects in a cloud folder. Each project has a folder of its own:
 *
 *   projects/<id>/project.json      the project file's manifest, plus the
 *                                   SHA-256 and size of each file it names
 *   projects/<id>/blobs/<sha-256>   the files, named by their content
 *
 * Naming files by content means a change to the mixer or the grid uploads
 * only project.json, and a download reuses the files this device already
 * has. The manifest is written after the files it names and old files are
 * removed after it, so another device always reads a whole project.
 */

const ROOT = "projects";
const MANIFEST = "project.json";
const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

interface FileRecord {
  sha256: string;
  size: number;
}

interface CloudManifest extends Manifest {
  files: Record<string, FileRecord>;
}

/** A project as listed in the cloud. */
export interface RemoteProject {
  id: string;
  name: string;
  updatedAt: number;
  status: ProjectStatus;
  sourceName: string | null;
  /** Total size of its files, in bytes. */
  size: number;
}

export type Progress = (done: number, total: number) => void;

export async function sha256(data: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await data.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function projectFolder(id: string): string {
  if (!PROJECT_ID.test(id)) throw new Error("Invalid project id.");
  return `${ROOT}/${id}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A project's manifest in the cloud, checked; null if there is none. */
async function readManifest(store: CloudStore, id: string): Promise<CloudManifest | null> {
  const blob = await store.read(`${projectFolder(id)}/${MANIFEST}`);
  if (!blob) return null;
  const manifest: unknown = JSON.parse(await blob.text());
  checkManifest(manifest);
  if (!isRecord(manifest.project) || manifest.project.id !== id || !isRecord(manifest.files)) {
    throw new Error(DAMAGED);
  }
  for (const record of Object.values(manifest.files)) {
    if (
      !isRecord(record) || typeof record.sha256 !== "string" || !HASH.test(record.sha256) ||
      !Number.isSafeInteger(record.size) || record.size < 0
    ) throw new Error(DAMAGED);
  }
  return manifest as unknown as CloudManifest;
}

function totalSize(files: Record<string, FileRecord>): number {
  return Object.values(files).reduce((sum, file) => sum + file.size, 0);
}

function describe(manifest: CloudManifest): RemoteProject {
  const project = manifest.project as Partial<Project>;
  return {
    id: String(project.id),
    name: typeof project.name === "string" && project.name ? project.name.slice(0, 80) : "Untitled",
    updatedAt: typeof project.updatedAt === "number" ? project.updatedAt : 0,
    status: (["empty", "ready", "processing", "interrupted", "failed"] as const)
        .find((status) => status === project.status) ?? "empty",
    sourceName: typeof project.sourceName === "string" ? project.sourceName.slice(0, 255) : null,
    size: totalSize(manifest.files),
  };
}

/** The projects in the cloud. A project that can't be read is left out. */
export async function listRemoteProjects(store: CloudStore): Promise<RemoteProject[]> {
  const ids = (await store.list(ROOT))
    .filter((entry) => entry.folder && PROJECT_ID.test(entry.name))
    .map((entry) => entry.name);
  const projects: RemoteProject[] = [];
  // A few manifests at a time: one request each.
  for (let i = 0; i < ids.length; i += 4) {
    const batch = await Promise.all(ids.slice(i, i + 4).map(async (id) => {
      try {
        const manifest = await readManifest(store, id);
        return manifest && describe(manifest);
      } catch (error) {
        console.warn(`Skipping cloud project ${id}.`, error);
        return null;
      }
    }));
    for (const project of batch) if (project) projects.push(project);
  }
  return projects;
}

/** The SHA-256 of each part, with the parts. */
async function hashParts(data: ProjectData) {
  const { manifest, parts } = await projectParts(data);
  const hashed = [];
  for (const part of parts) {
    hashed.push({ ...part, sha256: await sha256(part.data) });
  }
  return { manifest, parts: hashed };
}

/**
 * Uploads a project, replacing its copy in the cloud. Only files the cloud
 * doesn't have yet are sent. `progress` counts bytes.
 */
export async function uploadProject(
  store: CloudStore,
  data: ProjectData,
  progress?: Progress,
): Promise<RemoteProject> {
  const folder = projectFolder(data.project.id);
  const { manifest, parts } = await hashParts(data);
  const files: Record<string, FileRecord> = {};
  for (const part of parts) files[part.path] = { sha256: part.sha256, size: part.data.size };
  const stored = new Set(
    (await store.list(`${folder}/blobs`)).filter((entry) => !entry.folder).map((entry) => entry.name),
  );
  const missing = new Map<string, Blob>();
  for (const part of parts) {
    if (!stored.has(part.sha256)) missing.set(part.sha256, part.data);
  }
  const total = [...missing.values()].reduce((sum, blob) => sum + blob.size, 0);
  let done = 0;
  progress?.(0, total);
  for (const [hash, blob] of missing) {
    await store.write(`${folder}/blobs/${hash}`, blob, (sent) => progress?.(done + sent, total));
    done += blob.size;
  }
  const cloudManifest: CloudManifest = { ...manifest, files };
  await store.write(
    `${folder}/${MANIFEST}`,
    new Blob([JSON.stringify(cloudManifest, null, 2)], { type: "application/json" }),
  );
  // Files no longer named by the manifest (a replaced source, older stems).
  const used = new Set(parts.map((part) => part.sha256));
  for (const name of stored) {
    if (!used.has(name)) {
      await store.remove(`${folder}/blobs/${name}`).catch((error) =>
        console.warn("Could not remove an old cloud file.", error)
      );
    }
  }
  return describe(cloudManifest);
}

/**
 * Downloads a project from the cloud. Files that `local` (this device's copy)
 * already has are reused rather than downloaded. Every file is checked
 * against its hash. The project keeps the time of its last change.
 */
export async function downloadProject(
  store: CloudStore,
  id: string,
  local?: ProjectData,
  progress?: Progress,
): Promise<ProjectData> {
  const manifest = await readManifest(store, id);
  if (!manifest) throw new Error("That project is no longer in the cloud.");
  const have = new Map<string, Blob>();
  if (local) {
    for (const part of (await hashParts(local)).parts) have.set(part.sha256, part.data);
  }
  const needed = new Set(
    Object.values(manifest.files).filter((file) => !have.has(file.sha256)).map((file) => file.sha256),
  );
  const total = Object.values(manifest.files)
    .filter((file, index, all) =>
      needed.has(file.sha256) && all.findIndex((other) => other.sha256 === file.sha256) === index
    )
    .reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  progress?.(0, total);
  const folder = projectFolder(id);
  const data = await readProjectParts(manifest, async (path) => {
    const file = Object.hasOwn(manifest.files, path) ? manifest.files[path] : undefined;
    if (!file) throw new Error(DAMAGED);
    const cached = have.get(file.sha256);
    if (cached) return cached;
    const blob = await store.read(`${folder}/blobs/${file.sha256}`);
    if (!blob || blob.size !== file.size || await sha256(blob) !== file.sha256) {
      throw new Error(DAMAGED);
    }
    have.set(file.sha256, blob);
    done += blob.size;
    progress?.(done, total);
    return blob;
  });
  return data;
}

/** Removes a project from the cloud. */
export function removeRemoteProject(store: CloudStore, id: string): Promise<void> {
  return store.remove(projectFolder(id));
}

export interface SyncPlan {
  upload: Project[];
  download: RemoteProject[];
  /** Projects in the cloud that aren't on this device. */
  remoteOnly: RemoteProject[];
}

/**
 * What a sync does: the newest copy of each project wins. Projects being
 * separated wait for the next sync. Projects only in the cloud are listed
 * to download on request, so a sync doesn't fill this device's storage, and
 * a project deleted here stays in the cloud until removed there.
 */
export function planSync(local: Project[], remote: RemoteProject[]): SyncPlan {
  const remoteById = new Map(remote.map((project) => [project.id, project]));
  const plan: SyncPlan = { upload: [], download: [], remoteOnly: [] };
  for (const project of local) {
    const copy = remoteById.get(project.id);
    remoteById.delete(project.id);
    if (project.status === "processing") continue;
    if (!copy || project.updatedAt > copy.updatedAt) plan.upload.push(project);
    else if (copy.updatedAt > project.updatedAt) plan.download.push(copy);
  }
  plan.remoteOnly = [...remoteById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return plan;
}
