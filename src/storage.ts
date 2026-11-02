import {
  type ModelRecord,
  type Project,
  type Stem,
  STEMS,
  type StoredBlob,
} from "./types";

const DB_NAME = "osplit-pwa";
const DB_VERSION = 1;
const PROJECTS = "projects";
const SOURCES = "sources";
const STEM_BLOBS = "stems";
const MODELS = "models";

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(PROJECTS, { keyPath: "id" });
      db.createObjectStore(SOURCES, { keyPath: "id" });
      db.createObjectStore(STEM_BLOBS, { keyPath: "id" });
      db.createObjectStore(MODELS, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open project storage."));
    request.onblocked = () =>
      reject(new Error("Close other OSplit tabs to upgrade local storage."));
  });
  return database;
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
    const tx = db.transaction([PROJECTS, SOURCES, STEM_BLOBS], "readwrite");
    tx.objectStore(PROJECTS).delete(id);
    tx.objectStore(SOURCES).delete(id);
    const stems = tx.objectStore(STEM_BLOBS);
    const cursor = stems.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      if (String(current.key).startsWith(`${id}:`)) current.delete();
      current.continue();
    };
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
    const tx = db.transaction([PROJECTS, SOURCES, STEM_BLOBS], "readwrite");
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
      const cursor = tx.objectStore(STEM_BLOBS).openCursor();
      cursor.onsuccess = () => {
        const currentStem = cursor.result;
        if (!currentStem) return;
        if (String(currentStem.key).startsWith(`${project.id}:`)) {
          currentStem.delete();
        }
        currentStem.continue();
      };
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
    name: `${stem}.wav`,
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
): Promise<Project> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PROJECTS, STEM_BLOBS], "readwrite");
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
          name: `${stem}.wav`,
        };
        tx.objectStore(STEM_BLOBS).put(value);
      });
      updated = {
        ...current,
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
