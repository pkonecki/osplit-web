import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabaseForTests,
  completeSeparation,
  deleteModelVariants,
  deleteProject,
  getModel,
  getSource,
  getStem,
  latestModelVariant,
  listProjects,
  MIGRATIONS,
  putModel,
  putStem,
  replaceSource,
  saveProject,
} from "./storage";
import { newProject, STEMS } from "./types";

beforeEach(async () => {
  await closeDatabaseForTests();
  globalThis.indexedDB = new IDBFactory();
});

function stems(label: string) {
  return Object.fromEntries(
    STEMS.map((stem) => [stem, new Blob([`${label}-${stem}`])]),
  ) as Record<(typeof STEMS)[number], Blob>;
}

async function text(blob: Blob | undefined) {
  return blob ? await blob.text() : undefined;
}

describe("schema migrations", () => {
  it("creates every store on a fresh database", async () => {
    await saveProject(newProject("fresh"));
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("osplit-pwa");
      request.onsuccess = () => resolve(request.result);
    });
    expect(db.version).toBe(MIGRATIONS.length);
    expect([...db.objectStoreNames].sort()).toEqual(
      ["models", "projects", "sources", "stems"],
    );
    db.close();
  });

  it("keeps data written by an existing version-1 database", async () => {
    const legacy = newProject("from v1");
    await new Promise<void>((resolve) => {
      const request = indexedDB.open("osplit-pwa", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [name, keyPath] of [
          ["projects", "id"],
          ["sources", "id"],
          ["stems", "id"],
          ["models", "key"],
        ]) db.createObjectStore(name, { keyPath });
        request.transaction!.objectStore("projects").put(legacy);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    expect((await listProjects()).map((project) => project.name)).toEqual([
      "from v1",
    ]);
  });

  it("reports a newer database version from another tab clearly", async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.open("osplit-pwa", MIGRATIONS.length + 1);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    await expect(listProjects()).rejects.toThrow(
      /updated in another tab\. Reload/,
    );
  });

  it("closes its connection when another tab upgrades the schema", async () => {
    await listProjects();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("osplit-pwa", MIGRATIONS.length + 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      // No blocked event: the open connection closed on versionchange.
      request.onblocked = () => reject(new Error("upgrade was blocked"));
    });
    expect(upgraded.version).toBe(MIGRATIONS.length + 1);
    upgraded.close();
  });
});

describe("project stems", () => {
  it("deletes only the deleted project's source and stems", async () => {
    const kept = await saveProject(newProject("kept"));
    const removed = await saveProject(newProject("removed"));
    await replaceSource(kept, new Blob(["kept source"]), "kept.wav");
    await replaceSource(removed, new Blob(["removed source"]), "removed.wav");
    await completeSeparation(kept.id, stems("kept"));
    await completeSeparation(removed.id, stems("removed"));

    await deleteProject(removed.id);

    expect((await listProjects()).map((project) => project.name)).toEqual([
      "kept",
    ]);
    expect(await getSource(removed.id)).toBeUndefined();
    for (const stem of STEMS) {
      expect(await getStem(removed.id, stem)).toBeUndefined();
      expect(await text((await getStem(kept.id, stem))?.blob)).toBe(
        `kept-${stem}`,
      );
    }
  });

  it("clears old stems when the source is replaced", async () => {
    const project = await saveProject(newProject("song"));
    const other = await saveProject(newProject("other"));
    await replaceSource(project, new Blob(["v1"]), "v1.wav");
    await completeSeparation(project.id, stems("v1"));
    await putStem(other.id, "vocals", new Blob(["other vocals"]));

    const updated = await replaceSource(project, new Blob(["v2"]), "v2.wav");

    expect(updated.completedStems).toEqual([]);
    expect(updated.sourceName).toBe("v2.wav");
    expect(await text((await getSource(project.id))?.blob)).toBe("v2");
    for (const stem of STEMS) {
      expect(await getStem(project.id, stem)).toBeUndefined();
    }
    expect(await text((await getStem(other.id, "vocals"))?.blob)).toBe(
      "other vocals",
    );
  });

  it("does not match a project whose id starts with another's", async () => {
    const short = await saveProject({ ...newProject("short"), id: "abc" });
    const long = await saveProject({ ...newProject("long"), id: "abcd" });
    await putStem(short.id, "bass", new Blob(["short"]));
    await putStem(long.id, "bass", new Blob(["long"]));
    await deleteProject(short.id);
    expect(await text((await getStem(long.id, "bass"))?.blob)).toBe("long");
  });
});

describe("model cache", () => {
  const key = "fp16/bass.fp16.onnx";

  it("finds the latest copy of a model and removes the others", async () => {
    await putModel({ key, blob: new Blob(["legacy"]), storedAt: 1 });
    await putModel({ key: `${key}@aaa`, blob: new Blob(["a"]), storedAt: 2 });
    await putModel({ key: `${key}@bbb`, blob: new Blob(["b"]), storedAt: 3 });
    await putModel({
      key: "fp16/bass.fp16.onnx-other",
      blob: new Blob(["unrelated"]),
      storedAt: 4,
    });
    await putModel({
      key: "yt-dlp/current-wheel",
      blob: new Blob(["wheel"]),
      storedAt: 5,
    });

    expect((await latestModelVariant(key))?.key).toBe(`${key}@bbb`);

    await deleteModelVariants(key, `${key}@bbb`);

    expect(await getModel(key)).toBeUndefined();
    expect(await getModel(`${key}@aaa`)).toBeUndefined();
    expect(await text((await getModel(`${key}@bbb`))?.blob)).toBe("b");
    expect(await getModel("fp16/bass.fp16.onnx-other")).toBeDefined();
    expect(await getModel("yt-dlp/current-wheel")).toBeDefined();
  });
});
