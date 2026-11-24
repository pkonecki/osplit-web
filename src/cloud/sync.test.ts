import { describe, expect, it } from "vitest";
import type { ProjectData } from "../storage";
import { type AnalysisRecord, MODEL_STEMS, newProject, type Project, type Stem } from "../types";
import {
  downloadProject,
  listRemoteProjects,
  planSync,
  type RemoteProject,
  removeRemoteProject,
  settleConflict,
  sha256,
  uploadProject,
} from "./sync";
import { MemoryStore } from "./test-store";

const STEMS = MODEL_STEMS["spleeter-5"];

function flac(label: string): Blob {
  return new Blob(["fLaC", label], { type: "audio/flac" });
}

function projectData(label = "a"): ProjectData {
  const project: Project = {
    ...newProject(`Song ${label}`),
    status: "ready",
    sourceName: "song.mp3",
    completedStems: [...STEMS],
    taskProgress: 100,
    volumes: { vocals: 0.5 },
    updatedAt: 1_000,
  };
  const analysis: AnalysisRecord = {
    projectId: project.id,
    algorithmVersion: 3,
    source: "drums",
    duration: 10,
    bpm: 120,
    bpmConfidence: 0.9,
    alternativeBpm: null,
    beats: Float32Array.from([0.5, 1, 1.5]),
    beatsPerBar: 4,
    firstDownbeatIndex: 0,
  };
  return {
    project,
    source: { id: project.id, blob: new Blob([`source-${label}`], { type: "audio/mpeg" }), name: "song.mp3" },
    stems: Object.fromEntries(STEMS.map((stem) => [stem, flac(`${label}-${stem}`)])) as Partial<Record<Stem, Blob>>,
    peaks: Object.fromEntries(STEMS.map((stem) => [stem, Float32Array.from([0, 0.5, 1])])),
    analysis,
  };
}

function blobCount(store: MemoryStore, id: string): number {
  return [...store.files.keys()].filter((path) => path.startsWith(`projects/${id}/blobs/`)).length;
}

describe("cloud sync", () => {
  it("uploads a project and downloads it whole", async () => {
    const store = new MemoryStore();
    const data = projectData();
    const remote = await uploadProject(store, data);
    expect(remote).toMatchObject({ id: data.project.id, name: "Song a", updatedAt: 1_000, status: "ready" });
    // Source, 5 stems, analysis beats; the 5 identical peaks share one file.
    expect(blobCount(store, data.project.id)).toBe(8);
    expect(store.writes.at(-1)).toBe(`projects/${data.project.id}/project.json`);

    const copy = await downloadProject(store, data.project.id);
    expect(copy.project.updatedAt).toBe(1_000);
    expect(copy.project.volumes).toEqual({ vocals: 0.5 });
    expect(copy.project.status).toBe("ready");
    expect(await copy.stems.drums!.text()).toBe("fLaCa-drums");
    expect(copy.stems.drums!.type).toBe("audio/flac");
    expect(await copy.source!.blob.text()).toBe("source-a");
    expect(copy.analysis?.beats).toEqual(Float32Array.from([0.5, 1, 1.5]));
    expect(Array.from(copy.peaks.bass!)).toEqual([0, 0.5, 1]);

    expect(await listRemoteProjects(store)).toEqual([remote]);
  });

  it("sends only the manifest when only settings changed", async () => {
    const store = new MemoryStore();
    const data = projectData();
    await uploadProject(store, data);
    store.writes = [];
    const changed = { ...data, project: { ...data.project, volumes: { vocals: 0.2 }, updatedAt: 2_000 } };
    const progress: [number, number][] = [];
    await uploadProject(store, changed, (done, total) => progress.push([done, total]));
    expect(store.writes).toEqual([`projects/${data.project.id}/project.json`]);
    expect(progress).toEqual([[0, 0]]);
    const copy = await downloadProject(store, data.project.id);
    expect(copy.project.volumes).toEqual({ vocals: 0.2 });
  });

  it("removes files a new version no longer uses", async () => {
    const store = new MemoryStore();
    const data = projectData();
    await uploadProject(store, data);
    const oldSource = `projects/${data.project.id}/blobs/${await sha256(data.source!.blob)}`;
    expect(store.files.has(oldSource)).toBe(true);
    await uploadProject(store, { ...data, source: undefined, project: { ...data.project, sourceRemoved: true } });
    expect(store.files.has(oldSource)).toBe(false);
    expect(blobCount(store, data.project.id)).toBe(7);
  });

  it("reuses this device's files when downloading a change", async () => {
    const store = new MemoryStore();
    const data = projectData();
    await uploadProject(store, { ...data, project: { ...data.project, speed: 0.75, updatedAt: 3_000 } });
    store.reads = [];
    const copy = await downloadProject(store, data.project.id, data);
    expect(store.reads).toEqual([`projects/${data.project.id}/project.json`]);
    expect(copy.project.speed).toBe(0.75);
    expect(await copy.stems.vocals!.text()).toBe("fLaCa-vocals");
  });

  it("rejects a file that doesn't match its hash", async () => {
    const store = new MemoryStore();
    const data = projectData();
    await uploadProject(store, data);
    const path = `projects/${data.project.id}/blobs/${await sha256(data.stems.bass!)}`;
    store.files.set(path, flac("tampered"));
    await expect(downloadProject(store, data.project.id)).rejects.toThrow(/damaged/);
  });

  it("rejects a manifest naming a file outside the project", async () => {
    const store = new MemoryStore();
    const data = projectData();
    await uploadProject(store, data);
    const path = `projects/${data.project.id}/project.json`;
    const manifest = JSON.parse(await store.files.get(path)!.text());
    manifest.files["stems/bass.flac"].sha256 = "../../other";
    store.files.set(path, new Blob([JSON.stringify(manifest)]));
    await expect(downloadProject(store, data.project.id)).rejects.toThrow(/damaged/);
    // Listing leaves the unreadable project out.
    expect(await listRemoteProjects(store)).toEqual([]);
  });

  it("lists nothing in an empty folder and ignores stray files", async () => {
    const store = new MemoryStore();
    expect(await listRemoteProjects(store)).toEqual([]);
    store.files.set("projects/notes.txt", new Blob(["hi"]));
    store.files.set("projects/bad id!/project.json", new Blob(["{}"]));
    expect(await listRemoteProjects(store)).toEqual([]);
  });

  it("removes a project from the cloud", async () => {
    const store = new MemoryStore();
    const data = projectData();
    await uploadProject(store, data);
    await removeRemoteProject(store, data.project.id);
    expect(store.files.size).toBe(0);
  });
});

describe("settling a project changed in two places", () => {
  /** A project in the cloud as another device left it, and this device's other change. */
  async function changedTwice() {
    const store = new MemoryStore();
    const theirs = projectData("a");
    theirs.project.name = "Their name";
    theirs.project.updatedAt = 3_000;
    await uploadProject(store, theirs);
    const mine: ProjectData = {
      ...theirs,
      project: { ...theirs.project, name: "My name", volumes: { vocals: 0.1 }, updatedAt: 2_000 },
    };
    return { store, theirs, mine };
  }

  it("keeps this device's version: it replaces the cloud's", async () => {
    const { store, mine } = await changedTwice();
    const { write, uploaded } = await settleConflict(store, "here", mine);
    expect(write).toEqual([]);
    expect(uploaded?.name).toBe("My name");
    expect((await listRemoteProjects(store))[0].name).toBe("My name");
  });

  it("keeps the cloud's version: it comes down to replace this one", async () => {
    const { store, mine } = await changedTwice();
    const { write, uploaded } = await settleConflict(store, "cloud", mine);
    expect(uploaded).toBeNull();
    expect(write).toHaveLength(1);
    expect(write[0].project).toMatchObject({ id: mine.project.id, name: "Their name", updatedAt: 3_000 });
    expect((await listRemoteProjects(store))[0].name).toBe("Their name");
  });

  it("keeps both: the cloud's as a new project here, this one in the cloud", async () => {
    const { store, mine } = await changedTwice();
    const { write, uploaded } = await settleConflict(store, "both", mine);
    expect(write).toHaveLength(1);
    expect(write[0].project.id).not.toBe(mine.project.id);
    expect(write[0].project.name).toBe("Their name (other device)");
    expect(write[0].stems.vocals).toBeDefined();
    expect(uploaded?.name).toBe("My name");
  });
});

describe("planSync", () => {
  const local = (id: string, updatedAt: number, status: Project["status"] = "ready"): Project => ({
    ...newProject(id),
    id,
    updatedAt,
    status,
  });
  const remote = (id: string, updatedAt: number): RemoteProject => ({
    id,
    name: id,
    updatedAt,
    status: "ready",
    sourceName: null,
    size: 10,
  });

  it("syncs only projects in both places, newest winning without a record", () => {
    const plan = planSync(
      [local("new", 1), local("mine", 5), local("theirs", 1), local("same", 3), local("busy", 9, "processing")],
      [remote("mine", 2), remote("theirs", 4), remote("same", 3), remote("busy", 1), remote("away", 7), remote("older", 2)],
    );
    // A project only on this device isn't uploaded: that is manual.
    expect(plan.upload.map((project) => project.id)).toEqual(["mine"]);
    expect(plan.localOnly.map((project) => project.id)).toEqual(["new"]);
    expect(plan.download.map((project) => project.id)).toEqual(["theirs"]);
    expect(plan.remoteOnly.map((project) => project.id)).toEqual(["away", "older"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("sends the side changed since the last sync, and lists changes on both sides", () => {
    const syncedAt = { here: 10, there: 10, both: 10, neither: 10 };
    const plan = planSync(
      [local("here", 20), local("there", 10), local("both", 20), local("neither", 10)],
      [remote("here", 10), remote("there", 15), remote("both", 30), remote("neither", 10)],
      syncedAt,
    );
    expect(plan.upload.map((project) => project.id)).toEqual(["here"]);
    expect(plan.download.map((project) => project.id)).toEqual(["there"]);
    // Changed on both: even though the cloud copy is newer, the user chooses.
    expect(plan.conflicts.map((project) => project.id)).toEqual(["both"]);
  });
});
