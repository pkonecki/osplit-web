import { audioExtension } from "./audio-format";
import {
  type ModelRecord,
  type Project,
  type Stem,
  STEMS,
  type StoredBlob,
} from "./types";

const DB_NAME = "osplit-pwa";
const PROJECTS = "projects";
const SOURCES = "sources";
const STEM_BLOBS = "stems";
const MODELS = "models";
const PEAKS = "peaks";

/**
 * Schema changes, in order: migration N upgrades the database from version N
 * to N + 1. Never edit or reorder a released migration; append a new one. The
 * database version is the number of migrations.
 */
export const MIGRATIONS: ReadonlyArray<
  (db: IDBDatabase, transaction: IDBTransaction) => void
> = [
  (db) => {
    db.createObjectStore(PROJECTS, { keyPath: "id" });
    db.createObjectStore(SOURCES, { keyPath: "id" });
    db.createObjectStore(STEM_BLOBS, { keyPath: "id" });
    db.createObjectStore(MODELS, { keyPath: "key" });
  },
  // 2: waveform overviews, one record per stem, keyed `${projectId}:${stem}`.
  (db) => {
    db.createObjectStore(PEAKS, { keyPath: "id" });
  },
];

/** How long to wait for other tabs to release the database before an upgrade. */
const BLOCKED_TIMEOUT_MS = 10_000;

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, MIGRATIONS.length);
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const upgrade = request.transaction!;
      for (let version = event.oldVersion; version < MIGRATIONS.length; version++) {
        MIGRATIONS[version](db, upgrade);
      }
    };
    request.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = request.result;
      // Another tab is upgrading the schema: let it, and reopen on next use.
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(blockedTimer);
      reject(
        request.error?.name === "VersionError"
          ? new Error(
            "OSplit was updated in another tab. Reload this page to continue.",
          )
          : request.error ?? new Error("Could not open project storage."),
      );
    };
    // Tabs running this version close their connection on versionchange, so
    // the upgrade continues; older versions may hold it open indefinitely.
    request.onblocked = () => {
      blockedTimer = setTimeout(
        () =>
          reject(
            new Error(
              "Close other OSplit tabs or windows, then reload, to finish updating local storage.",
            ),
          ),
        BLOCKED_TIMEOUT_MS,
      );
    };
  });
  database.catch(() => {
    database = undefined;
  });
  return database;
}

/** For tests: drop the cached connection so the next call opens a new one. */
export async function closeDatabaseForTests(): Promise<void> {
  const current = database;
  database = undefined;
  (await current?.catch(() => undefined))?.close();
}

/** All stem records of a project: their keys are `${projectId}:${stem}`. */
export function projectStemRange(projectId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${projectId}:`, `${projectId}:￿`);
}

/** A model's cache keys: the bare key (older versions) and `${key}@${sha256}`. */
function modelVariantRange(key: string): IDBKeyRange {
  return IDBKeyRange.bound(key, `${key}@￿`);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Local storage operation failed."));
  });
}

async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (transaction: IDBTransaction) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(stores, mode);
  const request = action(tx);
  const result = await requestResult(request);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("Could not commit local storage changes."));
    tx.onabort = () =>
      reject(tx.error ?? new Error("Local storage changes were aborted."));
  });
  return result;
}

export async function listProjects(): Promise<Project[]> {
  return (await transaction(
    [PROJECTS],
    "readonly",
    (tx) => tx.objectStore(PROJECTS).getAll(),
  ))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string): Promise<Project | undefined> {
  return transaction(
    [PROJECTS],
    "readonly",
    (tx) => tx.objectStore(PROJECTS).get(id),
  );
}

export function saveProject(project: Project): Promise<Project> {
  const updated = { ...project, updatedAt: Date.now() };
  return transaction(
    [PROJECTS],
    "readwrite",
    (tx) => tx.objectStore(PROJECTS).put(updated),
  )
    .then(() => updated);
}

export async function updateProjectTask(
  projectId: string,
  task:
    & Pick<Project, "status">
    & Partial<Pick<Project, "taskProgress" | "taskStage" | "errorMessage">>,
): Promise<Project> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PROJECTS], "readwrite");
    const store = tx.objectStore(PROJECTS);
    const request = store.get(projectId);
    let updated: Project | undefined;
    request.onsuccess = () => {
      const current = request.result as Project | undefined;
      if (!current) {
        tx.abort();
        reject(new Error("Project no longer exists."));
        return;
      }
      updated = { ...current, ...task, updatedAt: Date.now() };
      store.put(updated);
    };
    request.onerror = () =>
      reject(
        request.error ?? new Error("Could not update project task status."),
      );
    tx.oncomplete = () => {
      if (updated) resolve(updated);
      else reject(new Error("Project task status was not updated."));
    };
    tx.onerror = () =>
      reject(tx.error ?? new Error("Could not save project task status."));
    tx.onabort = () =>
      reject(tx.error ?? new Error("Project task status update was aborted."));
  });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PROJECTS, SOURCES, STEM_BLOBS, PEAKS], "readwrite");
    tx.objectStore(PROJECTS).delete(id);
    tx.objectStore(SOURCES).delete(id);
    tx.objectStore(STEM_BLOBS).delete(projectStemRange(id));
    tx.objectStore(PEAKS).delete(projectStemRange(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("Could not delete the project."));
    tx.onabort = () =>
      reject(tx.error ?? new Error("Project deletion was aborted."));
  });
}

export async function replaceSource(
  project: Project,
  file: Blob,
  name: string,
): Promise<Project> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PROJECTS, SOURCES, STEM_BLOBS, PEAKS], "readwrite");
    const projects = tx.objectStore(PROJECTS);
    const sourceRequest = projects.get(project.id);
    let updated: Project | undefined;
    sourceRequest.onsuccess = () => {
      const current = sourceRequest.result as Project | undefined;
      if (!current) {
        tx.abort();
        reject(new Error("Project no longer exists."));
        return;
      }
      updated = {
        ...current,
        sourceName: name,
        sourceRemoved: false,
        status: "ready",
        completedStems: [],
        errorMessage: null,
        taskProgress: 0,
        taskStage: "",
        updatedAt: Date.now(),
      };
      projects.put(updated);
      tx.objectStore(SOURCES).put(
        { id: project.id, blob: file, name } satisfies StoredBlob,
      );
      tx.objectStore(STEM_BLOBS).delete(projectStemRange(project.id));
      tx.objectStore(PEAKS).delete(projectStemRange(project.id));
    };
    sourceRequest.onerror = () =>
      reject(
        sourceRequest.error ?? new Error("Could not update source audio."),
      );
    tx.oncomplete = () => {
      if (updated) resolve(updated);
      else reject(new Error("Source update did not finish."));
    };
    tx.onerror = () =>
      reject(
        tx.error ?? new Error("Could not save the selected source audio."),
      );
    tx.onabort = () =>
      reject(tx.error ?? new Error("Source update was aborted."));
  });
}

export function getSource(projectId: string): Promise<StoredBlob | undefined> {
  return transaction(
    [SOURCES],
    "readonly",
    (tx) => tx.objectStore(SOURCES).get(projectId),
  );
}

export async function putStem(
  projectId: string,
  stem: Stem,
  blob: Blob,
): Promise<void> {
  const value: StoredBlob = {
    id: `${projectId}:${stem}`,
    blob,
    name: `${stem}.${audioExtension(blob)}`,
  };
  await transaction(
    [STEM_BLOBS],
    "readwrite",
    (tx) => tx.objectStore(STEM_BLOBS).put(value),
  );
}

export function getStem(
  projectId: string,
  stem: Stem,
): Promise<StoredBlob | undefined> {
  return transaction(
    [STEM_BLOBS],
    "readonly",
    (tx) => tx.objectStore(STEM_BLOBS).get(`${projectId}:${stem}`),
  );
}

export async function completeSeparation(
  projectId: string,
  output: Record<Stem, Blob>,
  peaks?: Record<Stem, Float32Array>,
): Promise<Project> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [PROJECTS, SOURCES, STEM_BLOBS, PEAKS],
      "readwrite",
    );
    const projects = tx.objectStore(PROJECTS);
    const request = projects.get(projectId);
    let updated: Project | undefined;
    request.onsuccess = () => {
      const current = request.result as Project | undefined;
      if (!current) {
        tx.abort();
        reject(new Error("Project no longer exists."));
        return;
      }
      STEMS.forEach((stem) => {
        const value: StoredBlob = {
          id: `${projectId}:${stem}`,
          blob: output[stem],
          name: `${stem}.${audioExtension(output[stem])}`,
        };
        tx.objectStore(STEM_BLOBS).put(value);
        if (peaks) {
          tx.objectStore(PEAKS).put(
            { id: `${projectId}:${stem}`, peaks: peaks[stem] } satisfies StoredPeaks,
          );
        }
      });
      const removeSource = current.deleteSourceAfterSeparation === true;
      if (removeSource) tx.objectStore(SOURCES).delete(projectId);
      updated = {
        ...current,
        sourceRemoved: removeSource || current.sourceRemoved,
        status: "ready",
        completedStems: [...STEMS],
        errorMessage: null,
        taskProgress: 100,
        taskStage: "Separation complete",
        updatedAt: Date.now(),
      };
      projects.put(updated);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not save separated stems."));
    tx.oncomplete = () => {
      if (updated) resolve(updated);
      else reject(new Error("Stem processing did not finish."));
    };
    tx.onerror = () =>
      reject(tx.error ?? new Error("Could not commit separated stems."));
    tx.onabort = () =>
      reject(tx.error ?? new Error("Saving separated stems was aborted."));
  });
}

interface StoredPeaks {
  id: string;
  peaks: Float32Array;
}

/** Waveform overviews of a project's stems, for those that have one. */
export async function getPeaks(
  projectId: string,
): Promise<Partial<Record<Stem, Float32Array>>> {
  const records = await transaction(
    [PEAKS],
    "readonly",
    (tx) => tx.objectStore(PEAKS).getAll(projectStemRange(projectId)) as IDBRequest<
      StoredPeaks[]
    >,
  );
  return Object.fromEntries(
    records.map((record) => [record.id.slice(projectId.length + 1), record.peaks]),
  );
}

export async function putPeaks(
  projectId: string,
  stem: Stem,
  peaks: Float32Array,
): Promise<void> {
  await transaction(
    [PEAKS],
    "readwrite",
    (tx) => tx.objectStore(PEAKS).put({ id: `${projectId}:${stem}`, peaks } satisfies StoredPeaks),
  );
}

export async function putModel(record: ModelRecord): Promise<void> {
  await transaction(
    [MODELS],
    "readwrite",
    (tx) => tx.objectStore(MODELS).put(record),
  );
}

export function getModel(key: string): Promise<ModelRecord | undefined> {
  return transaction(
    [MODELS],
    "readonly",
    (tx) => tx.objectStore(MODELS).get(key),
  );
}

function isModelVariant(recordKey: IDBValidKey, key: string): boolean {
  return recordKey === key ||
    (typeof recordKey === "string" && recordKey.startsWith(`${key}@`));
}

/** The most recently stored copy of a model, whatever its checksum. */
export async function latestModelVariant(
  key: string,
): Promise<ModelRecord | undefined> {
  const records = await transaction(
    [MODELS],
    "readonly",
    (tx) =>
      tx.objectStore(MODELS).getAll(modelVariantRange(key)) as IDBRequest<
        ModelRecord[]
      >,
  );
  return records
    .filter((record) => isModelVariant(record.key, key))
    .sort((a, b) => b.storedAt - a.storedAt)[0];
}

/** Deletes every cached copy of a model except the one stored as `keep`. */
export async function deleteModelVariants(
  key: string,
  keep: string,
): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([MODELS], "readwrite");
    const cursor = tx.objectStore(MODELS).openCursor(modelVariantRange(key));
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      if (current.key !== keep && isModelVariant(current.key, key)) {
        current.delete();
      }
      current.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("Could not remove old model copies."));
    tx.onabort = () =>
      reject(tx.error ?? new Error("Removing old model copies was aborted."));
  });
}

export async function storageEstimate(): Promise<StorageEstimate | null> {
  return navigator.storage?.estimate ? navigator.storage.estimate() : null;
}

export async function requestPersistentStorage(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}
