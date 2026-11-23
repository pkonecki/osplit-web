import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asCopy,
  createProjectFile,
  isProjectFile,
  PROJECT_FILE_VERSION,
  projectFileName,
  readProjectFile,
} from "./project-file";
import {
  closeDatabaseForTests,
  completeSeparation,
  getAnalysis,
  getPeaks,
  getProject,
  getSource,
  getStem,
  putAnalysis,
  readProjectData,
  replaceSource,
  saveProject,
  writeProjectData,
} from "./storage";
import { type AnalysisRecord, MODEL_STEMS, newProject, type Stem } from "./types";

/** Spleeter's five stems: the default model's. */
const STEMS = MODEL_STEMS["spleeter-5"];
const DEMUCS = MODEL_STEMS["htdemucs-6s"];
import { createZip, readZip, type ZipEntry } from "./zip";

beforeEach(async () => {
  await closeDatabaseForTests();
  globalThis.indexedDB = new IDBFactory();
});

/** A blob that passes for a FLAC stem: the magic bytes, then a label. */
function flac(label: string): Blob {
  return new Blob(["fLaC", label], { type: "audio/flac" });
}

function stems(label: string, set: readonly Stem[] = STEMS): Partial<Record<Stem, Blob>> {
  return Object.fromEntries(set.map((stem) => [stem, flac(`${label}-${stem}`)]));
}

function peaks(): Partial<Record<Stem, Float32Array>> {
  return Object.fromEntries(
    STEMS.map((stem, i) => [stem, Float32Array.from([0, 0.25 * i, 0.5, 1])]),
  );
}

function analysis(projectId: string): AnalysisRecord {
  return {
    projectId,
    algorithmVersion: 3,
    source: "drums",
    duration: 10,
    bpm: 120,
    bpmConfidence: 0.9,
    alternativeBpm: 60,
    beats: Float32Array.from([0.5, 1, 1.5, 2]),
    beatsPerBar: 4,
    firstDownbeatIndex: 1,
    edits: { bpmFactor: 2, tapped: { bpm: 121, anchor: 0.5 } },
    tuningCents: -12,
    key: { tonic: 9, mode: "minor", confidence: 0.7, alternative: { tonic: 0, mode: "major" } },
    modulations: [{ tonic: 9, mode: "minor", start: 0 }],
    chords: [
      { start: 0, end: 2, root: 9, quality: "min" },
      { start: 2, end: 4, root: 0, quality: "maj", bass: 4 },
      { start: 4, end: 10, root: null, quality: "maj" },
    ],
    keyOverride: { tonic: 2, mode: "minor" },
  };
}

/** A separated project with every kind of data, stored. */
async function storedProject() {
  const project = await saveProject({
    ...newProject("Live / take 2"),
    speed: 0.85,
    semitones: -2,
    loop: { start: 1, end: 3, enabled: true },
    volumes: { vocals: 0.5, piano: 1, drums: 0.2, bass: 1, other: 0 },
    mutedStems: ["piano"],
    soloStems: ["click"],
    clickOn: true,
    clickVolume: 0.4,
    chordNames: "original",
  });
  await replaceSource(project, new Blob(["source audio"], { type: "audio/mpeg" }), "take2.mp3");
  await completeSeparation(project.id, stems("a"), peaks());
  await putAnalysis(analysis(project.id));
  return project;
}

async function exported(projectId: string): Promise<Blob> {
  const data = await readProjectData(projectId);
  return createProjectFile(data!);
}

/** Rewrites one entry of a project file (the manifest, given as JSON). */
async function rewritten(
  file: Blob,
  change: (name: string, data: Blob) => Blob | Promise<Blob>,
): Promise<Blob> {
  const entries: ZipEntry[] = [];
  for (const entry of await readZip(file)) {
    entries.push({ name: entry.name, data: await change(entry.name, entry.data) });
  }
  return createZip(entries);
}

async function withManifest(file: Blob, edit: (manifest: any) => void): Promise<Blob> {
  return rewritten(file, async (name, data) => {
    if (name !== "osplit.json") return data;
    const manifest = JSON.parse(await data.text());
    edit(manifest);
    return new Blob([JSON.stringify(manifest)]);
  });
}

describe("project files", () => {
  it("recognises and names project files", () => {
    expect(isProjectFile({ name: "Song.OSPLIT" })).toBe(true);
    expect(isProjectFile({ name: "song.zip" })).toBe(false);
    expect(projectFileName(newProject("Live / take 2"))).toBe("Live _ take 2.osplit");
  });

  it("round-trips a project with its source, stems, waveforms and analysis", async () => {
    const original = await storedProject();
    const file = await exported(original.id);
    const names = (await readZip(file)).map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining([
      "osplit.json",
      "source/take2.mp3",
      "stems/vocals.flac",
      "peaks/other.f32",
      "analysis/beats.f32",
    ]));

    // On "another device": a fresh database.
    await closeDatabaseForTests();
    globalThis.indexedDB = new IDBFactory();
    const imported = await writeProjectData(await readProjectFile(file));

    const project = await getProject(original.id);
    expect(project).toEqual(imported);
    expect(project).toMatchObject({
      id: original.id,
      name: "Live / take 2",
      status: "ready",
      sourceName: "take2.mp3",
      completedStems: [...STEMS],
      speed: 0.85,
      semitones: -2,
      loop: { start: 1, end: 3, enabled: true },
      volumes: { vocals: 0.5, piano: 1, drums: 0.2, bass: 1, other: 0 },
      mutedStems: ["piano"],
      soloStems: ["click"],
      clickOn: true,
      clickVolume: 0.4,
      chordNames: "original",
    });
    const source = await getSource(original.id);
    expect(await source?.blob.text()).toBe("source audio");
    expect(source?.blob.type).toBe("audio/mpeg");
    for (const stem of STEMS) {
      const stored = await getStem(original.id, stem);
      expect(await stored?.blob.text()).toBe(`fLaCa-${stem}`);
      expect(stored?.blob.type).toBe("audio/flac");
    }
    expect(await getPeaks(original.id)).toEqual(peaks());
    expect(await getAnalysis(original.id)).toEqual(analysis(original.id));
  });

  it("exports a project whose source was deleted after separation", async () => {
    const project = await saveProject({
      ...newProject("No source"),
      deleteSourceAfterSeparation: true,
    });
    await replaceSource(project, new Blob(["src"]), "a.wav");
    await completeSeparation(project.id, stems("b"));
    const data = await readProjectFile(await exported(project.id));
    expect(data.source).toBeUndefined();
    expect(data.project).toMatchObject({ sourceName: "a.wav", sourceRemoved: true, status: "ready" });
    expect(data.peaks).toEqual({});
  });

  it("imports an unseparated project with only its source", async () => {
    const project = await saveProject(newProject("Just audio"));
    await replaceSource(project, new Blob(["src"]), "a.wav");
    const data = await readProjectFile(await exported(project.id));
    expect(data.project).toMatchObject({ status: "ready", sourceName: "a.wav", completedStems: [] });
    expect(data.stems).toEqual({});
  });

  it("marks a project exported mid-separation as interrupted", async () => {
    const project = await saveProject({ ...newProject("Busy"), status: "processing" });
    await replaceSource(project, new Blob(["src"]), "a.wav");
    const file = await withManifest(await exported(project.id), (manifest) => {
      manifest.project.status = "processing";
    });
    const data = await readProjectFile(file);
    expect(data.project.status).toBe("interrupted");
    expect(data.project.errorMessage).toMatch(/didn't finish/);
  });

  it("drops a partial set of stems", async () => {
    const project = await storedProject();
    const file = await withManifest(await exported(project.id), (manifest) => {
      delete manifest.stems.bass;
    });
    const data = await readProjectFile(file);
    expect(data.stems).toEqual({});
    expect(data.project.completedStems).toEqual([]);
    expect(data.analysis).toBeUndefined();
    expect(data.project.status).toBe("ready");
  });

  it("round-trips a Demucs project with its six stems", async () => {
    const project = await saveProject({
      ...newProject("Six", "htdemucs-6s"),
      volumes: { guitar: 0.3 },
    });
    await replaceSource(project, new Blob(["src"]), "a.wav");
    await completeSeparation(project.id, stems("d", DEMUCS));
    const data = await readProjectFile(await exported(project.id));
    expect(data.project).toMatchObject({
      model: "htdemucs-6s",
      completedStems: [...DEMUCS],
      volumes: { guitar: 0.3 },
      status: "ready",
    });
    // Stems without a stored volume stay without one (full volume).
    expect(data.project.volumes.vocals).toBeUndefined();
    expect(await data.stems.guitar?.text()).toBe("fLaCd-guitar");
  });

  it("drops a Demucs project's stems when guitar is missing", async () => {
    const project = await saveProject(newProject("Six", "htdemucs-6s"));
    await replaceSource(project, new Blob(["src"]), "a.wav");
    await completeSeparation(project.id, stems("d", DEMUCS));
    const file = await withManifest(await exported(project.id), (manifest) => {
      delete manifest.stems.guitar;
    });
    const data = await readProjectFile(file);
    expect(data.project.completedStems).toEqual([]);
    expect(data.stems).toEqual({});
  });

  it("keeps both projects with a copy under a new id", async () => {
    const project = await storedProject();
    const copy = asCopy(await readProjectFile(await exported(project.id)));
    expect(copy.project.id).not.toBe(project.id);
    expect(copy.project.name).toBe("Live / take 2 (copy)");
    await writeProjectData(copy);
    expect(await getProject(project.id)).toBeDefined();
    expect((await getAnalysis(copy.project.id))?.projectId).toBe(copy.project.id);
    expect(await getStem(copy.project.id, "drums")).toBeDefined();
    expect(await getSource(copy.project.id)).toMatchObject({ id: copy.project.id });
  });

  it("replaces every record of a project already stored", async () => {
    const project = await storedProject();
    const data = await readProjectFile(await exported(project.id));
    // Meanwhile on this device: the project was separated again, unanalysed.
    await completeSeparation(project.id, stems("new"));
    await writeProjectData({ ...data, analysis: undefined, peaks: {} });
    expect(await getAnalysis(project.id)).toBeUndefined();
    expect(await getPeaks(project.id)).toEqual({});
    expect(await (await getStem(project.id, "vocals"))?.blob.text()).toBe("fLaCa-vocals");
  });

  it("rejects files that aren't project files", async () => {
    await expect(readProjectFile(new Blob(["hello"]))).rejects.toThrow(/isn't an OSplit project/);
    const zip = await createZip([{ name: "stems.flac", data: flac("x") }]);
    await expect(readProjectFile(zip)).rejects.toThrow(/isn't an OSplit project/);
  });

  it("asks for an update to read files from a newer version", async () => {
    const project = await storedProject();
    const file = await withManifest(await exported(project.id), (manifest) => {
      manifest.version = PROJECT_FILE_VERSION + 1;
    });
    await expect(readProjectFile(file)).rejects.toThrow(/newer version/);
  });

  it("detects damaged audio by its checksum", async () => {
    const project = await storedProject();
    const file = await exported(project.id);
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Flip a byte of the vocals stem's data, leaving the headers intact.
    const vocals = (await readZip(file)).find((entry) => entry.name === "stems/vocals.flac")!;
    const offset = indexOf(bytes, new Uint8Array(await vocals.data.arrayBuffer()));
    bytes[offset + 5] ^= 0xff;
    await expect(readProjectFile(new Blob([bytes]))).rejects.toThrow(/damaged/);
  });

  it("checks every value in the manifest", async () => {
    const project = await storedProject();
    const file = await withManifest(await exported(project.id), (manifest) => {
      Object.assign(manifest.project, {
        id: "../../evil:id",
        name: 42,
        speed: 99,
        semitones: -40,
        volumes: { vocals: 7, piano: "loud" },
        mutedStems: ["vocals", "kazoo"],
        loop: { start: 5, end: 1, enabled: true },
        quality: "fp64",
        status: "hacked",
      });
    });
    const { project: read } = await readProjectFile(file);
    expect(read.id).not.toBe("../../evil:id");
    expect(read.id).toMatch(/^[A-Za-z0-9-]+$/);
    expect(read).toMatchObject({
      name: "Imported project",
      speed: 1.5,
      semitones: -12,
      mutedStems: ["vocals"],
      status: "ready",
    });
    expect(read.quality).toBeUndefined();
    expect(read.volumes).toMatchObject({ vocals: 1, piano: 1 });
    expect(read.loop).toBeUndefined();
  });

  it("drops a malformed analysis, to be redone", async () => {
    const project = await storedProject();
    const file = await withManifest(await exported(project.id), (manifest) => {
      manifest.analysis.chords[1].root = 12;
    });
    const data = await readProjectFile(file);
    expect(data.analysis).toBeUndefined();
    expect(data.project.completedStems).toEqual([...STEMS]);
  });
});

/** Position of `needle` in `haystack`. */
function indexOf(haystack: Uint8Array, target: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  throw new Error("not found");
}
