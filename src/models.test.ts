import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadModel,
  type ModelManifest,
  modelCacheKey,
  parseModelManifest,
  resetModelManifest,
  sha256Hex,
  verifyModelBytes,
} from "./models";
import {
  closeDatabaseForTests,
  getModel,
  latestModelVariant,
  putModel,
} from "./storage";

const KEY = "fp16/vocals.fp16.onnx";
const MODEL = new TextEncoder().encode("pretend this is an ONNX model");

async function entryFor(bytes: Uint8Array) {
  return {
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes.slice().buffer),
  };
}

/** A fetch that serves the model list and model files, and counts requests. */
function fakeServer(manifest: ModelManifest, files: Record<string, Uint8Array>) {
  const requests: string[] = [];
  let offline = false;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (offline) throw new TypeError("Failed to fetch");
    if (url.endsWith("models/models.json")) return Response.json(manifest);
    const name = Object.keys(files).find((key) => url.endsWith(`models/${key}`));
    return name
      ? new Response(files[name].slice())
      : new Response("missing", { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    goOffline() {
      offline = true;
    },
  };
}

const noProgress = { onProgress: () => {}, checkCancelled: () => {} };

beforeEach(async () => {
  await closeDatabaseForTests();
  globalThis.indexedDB = new IDBFactory();
  resetModelManifest();
});

describe("model list", () => {
  it("accepts valid entries and rejects malformed ones", async () => {
    const entry = await entryFor(MODEL);
    expect(parseModelManifest({ [KEY]: entry })).toEqual({ [KEY]: entry });
    expect(() => parseModelManifest([])).toThrow();
    expect(() => parseModelManifest({ [KEY]: { size: 1, sha256: "xyz" } }))
      .toThrow(/not valid/);
    expect(() =>
      parseModelManifest({ [KEY]: { size: -1, sha256: entry.sha256 } })
    ).toThrow(/not valid/);
  });

  it("verifies size and checksum", async () => {
    const entry = await entryFor(MODEL);
    await expect(verifyModelBytes(KEY, MODEL.slice().buffer, entry)).resolves
      .toBeUndefined();
    const tampered = MODEL.slice();
    tampered[3] ^= 0xff;
    await expect(verifyModelBytes(KEY, tampered.buffer, entry)).rejects.toThrow(
      /corrupted/,
    );
    await expect(
      verifyModelBytes(KEY, MODEL.slice(1).buffer, entry),
    ).rejects.toThrow(/incomplete/);
  });
});

describe("loadModel", () => {
  it("downloads, verifies and caches under the checksum key", async () => {
    const entry = await entryFor(MODEL);
    const server = fakeServer({ [KEY]: entry }, { [KEY]: MODEL });
    const progress: number[] = [];

    const bytes = await loadModel("fp16", "vocals", {
      ...noProgress,
      onProgress: (fraction) => progress.push(fraction),
      fetchImpl: server.fetchImpl,
    });

    expect(new Uint8Array(bytes)).toEqual(MODEL);
    expect(progress.at(-1)).toBe(1);
    expect(await getModel(modelCacheKey(KEY, entry))).toBeDefined();

    // A second load comes from the cache: only the model list is fetched.
    const before = server.requests.length;
    resetModelManifest();
    await loadModel("fp16", "vocals", { ...noProgress, fetchImpl: server.fetchImpl });
    expect(server.requests.slice(before)).toEqual([
      expect.stringMatching(/models\.json$/),
    ]);
  });

  it("rejects a corrupted download and caches nothing", async () => {
    const entry = await entryFor(MODEL);
    const corrupted = MODEL.slice();
    corrupted[0] ^= 0xff;
    const server = fakeServer({ [KEY]: entry }, { [KEY]: corrupted });
    await expect(
      loadModel("fp16", "vocals", { ...noProgress, fetchImpl: server.fetchImpl }),
    ).rejects.toThrow(/corrupted/);
    expect(await latestModelVariant(KEY)).toBeUndefined();
  });

  it("downloads a changed model again and drops the old copy", async () => {
    await putModel({ key: KEY, blob: new Blob(["very old"]), storedAt: 1 });
    await putModel({ key: `${KEY}@old`, blob: new Blob(["old"]), storedAt: 2 });
    const entry = await entryFor(MODEL);
    const server = fakeServer({ [KEY]: entry }, { [KEY]: MODEL });

    await loadModel("fp16", "vocals", { ...noProgress, fetchImpl: server.fetchImpl });

    expect(await getModel(KEY)).toBeUndefined();
    expect(await getModel(`${KEY}@old`)).toBeUndefined();
    expect(await getModel(modelCacheKey(KEY, entry))).toBeDefined();
  });

  it("uses the cached copy when the model list cannot be fetched", async () => {
    const entry = await entryFor(MODEL);
    const server = fakeServer({ [KEY]: entry }, { [KEY]: MODEL });
    await loadModel("fp16", "vocals", { ...noProgress, fetchImpl: server.fetchImpl });

    resetModelManifest();
    server.goOffline();
    const bytes = await loadModel("fp16", "vocals", {
      ...noProgress,
      fetchImpl: server.fetchImpl,
    });
    expect(new Uint8Array(bytes)).toEqual(MODEL);
  });

  it("fails offline when the model was never downloaded", async () => {
    const server = fakeServer({}, {});
    server.goOffline();
    await expect(
      loadModel("fp16", "vocals", { ...noProgress, fetchImpl: server.fetchImpl }),
    ).rejects.toThrow(/Failed to fetch/);
  });

  it("stops downloading when cancelled", async () => {
    const entry = await entryFor(MODEL);
    const server = fakeServer({ [KEY]: entry }, { [KEY]: MODEL });
    let checks = 0;
    await expect(
      loadModel("fp16", "vocals", {
        onProgress: () => {},
        checkCancelled: () => {
          if (++checks > 1) throw new DOMException("cancelled", "AbortError");
        },
        fetchImpl: server.fetchImpl,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(await latestModelVariant(KEY)).toBeUndefined();
  });
});
