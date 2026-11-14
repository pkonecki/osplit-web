import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  createProjectWithClip,
  instrument,
  openApp,
  readStore,
  recordProgress,
  seekTo,
  separateClip,
  SEPARATION_TIMEOUT,
  writeTestClip,
} from "./helpers";

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  writeTestClip(clip);
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(instrument);
});

test("becomes cross-origin isolated, reloading at most once", async ({ page }, testInfo) => {
  let loads = 0;
  page.on("load", () => loads++);
  await openApp(page);
  // Behind nginx-like headers there is nothing to fix; on a GitHub Pages-like
  // host the service worker adds the headers and the app reloads once.
  expect(loads).toBe(testInfo.project.name === "pages" ? 2 : 1);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe("function");

  await page.reload();
  await expect(page.locator("h1")).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(loads).toBe(testInfo.project.name === "pages" ? 3 : 2);
});

test("prunes caches from older app versions", async ({ page, context }) => {
  // Seed old caches before the service worker first activates.
  await context.route("**/sw.js", (route) => route.abort());
  await page.goto("./");
  await expect(page.locator("h1")).toBeVisible();
  const base = new URL(page.url()).pathname;
  await page.evaluate(async (base) => {
    await (await caches.open("osplit-shell-v1")).put("/old", new Response("old"));
    await (await caches.open("osplit-assets"))
      .put(`${base}assets/stale-123.js`, new Response("stale"));
  }, base);
  await context.unroute("**/sw.js");
  await openApp(page);

  await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain(
    "osplit-shell-v1",
  );
  const caches = await page.evaluate(async () => {
    const result: Record<string, string[]> = {};
    for (const key of await caches.keys()) {
      result[key] = (await (await caches.open(key)).keys())
        .map((request) => new URL(request.url).pathname);
    }
    return result;
  });
  const shell = Object.keys(caches).find((key) => key.startsWith("osplit-shell-"));
  expect(shell).toMatch(/^osplit-shell-[0-9a-f]{12}$/);
  expect(caches[shell!]).toContain(`${base}README-web.html`);
  expect(caches[shell!].some((path) => path.endsWith(".wasm"))).toBe(false);
  expect(caches["osplit-assets"] ?? []).not.toContain(`${base}assets/stale-123.js`);
});

test("works offline after the first visit", async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Your projects");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.goto("README-web.html");
  await expect(page).toHaveTitle("OSplit Web — Browser notes");
  await page.goto("./");
  await expect(page.locator("#app")).toBeAttached();
});

test("shows an error when the source audio is missing", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("osplit-pwa");
      request.onsuccess = () => resolve(request.result);
    });
    const now = Date.now();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put({
        id: "no-source",
        name: "Missing source",
        createdAt: now,
        updatedAt: now,
        sourceName: "ghost.wav",
        status: "ready",
        quality: "fp16",
        completedStems: [],
        volumes: { vocals: 1, piano: 1, drums: 1, bass: 1, other: 1 },
        mutedStems: [],
        errorMessage: null,
      });
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await page.click('[data-action="open"][data-id="no-source"]');
  await page.click('[data-action="separate"]');
  await expect(page.locator(".message span")).toHaveText(
    "Import a local audio file before separating stems.",
  );
  await expect(page.locator('[data-action="import"]')).toBeEnabled();
});

test("keeps typed text when the page re-renders", async ({ page }) => {
  await openApp(page);
  await createProjectWithClip(page, "Typing", clip);
  const url = page.locator("#media-url");
  await url.fill("https://example.com/song");
  // Switching quality saves the project and re-renders the whole view.
  await page.click('[data-action="quality"][data-quality="fp32"]');
  await expect(page.locator('[data-quality="fp32"]')).toHaveClass(/selected/);
  await expect(url).toHaveValue("https://example.com/song");

  // A re-render while the field has focus keeps focus and the cursor
  // position (the button is clicked by script so focus stays in the field).
  await url.click();
  await url.press("Home");
  await page.locator('[data-action="quality"][data-quality="fp16"]').evaluate(
    (button: HTMLButtonElement) => button.click(),
  );
  await expect(page.locator('[data-quality="fp16"]')).toHaveClass(/selected/);
  await expect(url).toHaveValue("https://example.com/song");
  await expect(url).toBeFocused();
  expect(await url.evaluate((input: HTMLInputElement) => input.selectionStart))
    .toBe(0);

  // Text typed on one project does not leak into another project's page.
  await page.click('[data-action="home"]');
  await createProjectWithClip(page, "Other", clip);
  await expect(page.locator("#media-url")).toHaveValue("");
});

test("separates a clip and mixes the stems", async ({ page }) => {
  await openApp(page);
  await createProjectWithClip(page, "E2E clip", clip);
  await recordProgress(page);
  const writesBefore = await page.evaluate(() => window.__projectWrites);
  const started = Date.now();

  await page.click('[data-action="separate"]');
  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({
    timeout: SEPARATION_TIMEOUT,
  });
  const seconds = (Date.now() - started) / 1000;

  // Progress never goes backwards and ends at 100%.
  const values = (await page.evaluate(() => window.__progress)).map((p) => p.value);
  expect(values.length).toBeGreaterThan(3);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(values.at(-1)).toBe(100);
  // Progress is saved at most about once per second.
  const writes = (await page.evaluate(() => window.__projectWrites)) - writesBefore;
  expect(writes).toBeLessThanOrEqual(Math.ceil(seconds) + 6);

  // Five FLAC stems that decode to the clip's length; models cached under
  // checksum keys.
  const stems = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("osplit-pwa");
      request.onsuccess = () => resolve(request.result);
    });
    const records = await new Promise<{ name: string; blob: Blob }[]>((resolve) => {
      const request = db.transaction("stems").objectStore("stems").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return Promise.all(records.map(async (record) => {
      const bytes = await record.blob.arrayBuffer();
      const magic = String.fromCharCode(...new Uint8Array(bytes.slice(0, 4)));
      const decoded = await new OfflineAudioContext(2, 1, 44_100)
        .decodeAudioData(bytes.slice(0));
      return {
        name: record.name,
        type: record.blob.type,
        magic,
        size: record.blob.size,
        frames: decoded.length,
        channels: decoded.numberOfChannels,
      };
    }));
  });
  expect(stems).toHaveLength(5);
  for (const stem of stems) {
    expect(stem).toMatchObject({
      type: "audio/flac",
      magic: "fLaC",
      frames: 44_100 * 3,
      channels: 2,
    });
    expect(stem.name).toMatch(/\.flac$/);
    // Smaller than the 16-bit WAV it replaces.
    expect(stem.size).toBeLessThan(44 + 44_100 * 3 * 4);
  }
  const modelKeys = await readStore<string>(page, "models", "keys");
  expect(modelKeys.filter((key) => /^fp16\/\w+\.fp16\.onnx@[0-9a-f]{64}$/.test(key)))
    .toHaveLength(5);

  // Mixer: the stems play from decoded buffers, started together, with one
  // gain node each; mute and unmute.
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__gains.length)).toBe(5);
  const starts = await page.evaluate(() => window.__starts);
  expect(starts).toHaveLength(5);
  expect(new Set(starts.map((start) => `${start.when}@${start.offset}`)).size).toBe(1);
  const slider = page.locator('[data-action="volume"][data-stem="vocals"]');
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const writesBeforeDrag = await page.evaluate(() => window.__projectWrites);
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 0; step < 15; step++) {
    await page.mouse.move(box.x + box.width * (0.8 - step * 0.04), box.y + box.height / 2);
  }
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__projectWrites))
    .toBe(writesBeforeDrag + 1);
  const vocalsGain = await page.evaluate(() => window.__gains[0].gain.value);
  expect(vocalsGain).toBeCloseTo(Number(await slider.inputValue()), 5);
  await page.click('[data-action="mute"][data-stem="drums"]');
  expect(await page.evaluate(() => window.__gains[2].gain.value)).toBe(0);
  await page.click('[data-action="mute"][data-stem="drums"]');
  expect(await page.evaluate(() => window.__gains[2].gain.value)).toBe(1);

  // Export one stem, as FLAC by default and as WAV when chosen.
  const flacDownload = page.waitForEvent("download");
  await page.click('[data-action="export-stem"][data-stem="vocals"]');
  const flac = await flacDownload;
  expect(flac.suggestedFilename()).toBe("E2E clip-vocals.flac");
  expect(readFileSync(await flac.path()).subarray(0, 4).toString()).toBe("fLaC");

  await page.selectOption('[data-action="export-format"]', "wav");
  const wavDownload = page.waitForEvent("download");
  await page.click('[data-action="export-stem"][data-stem="vocals"]');
  const wav = await wavDownload;
  expect(wav.suggestedFilename()).toBe("E2E clip-vocals.wav");
  const wavBytes = readFileSync(await wav.path());
  expect(wavBytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(wavBytes.length).toBe(44 + 44_100 * 3 * 4);

  // The choice is remembered, and also applies to the mix.
  await page.reload();
  await expect(page.locator('[data-action="export-format"]')).toHaveValue("wav");
  const mixDownload = page.waitForEvent("download");
  await page.click('[data-action="export-mix"]');
  const mix = await mixDownload;
  expect(mix.suggestedFilename()).toBe("E2E clip-mix.wav");
  expect(readFileSync(await mix.path()).length).toBe(44 + 44_100 * 3 * 4);
});

test("plays the stems sample-aligned through seeks and pauses", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Sync", clip);
  await page.click('[data-action="play"]');
  // The position follows the audio clock while playing.
  const seekBar = page.locator("#seek-bar");
  await expect.poll(async () => Number(await seekBar.inputValue())).toBeGreaterThan(0.2);
  await seekTo(page, 1);
  await page.waitForTimeout(200);
  await seekTo(page, 2);
  await page.waitForTimeout(200);
  await page.click('[data-action="play"]'); // pause
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Play");
  await page.click('[data-action="play"]'); // resume
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Pause");

  const starts = await page.evaluate(() => window.__starts);
  expect(starts).toHaveLength(5 * 4);
  const runs = Array.from({ length: 4 }, (_, run) => starts.slice(run * 5, run * 5 + 5));
  for (const run of runs) {
    // All five stems of a run share the exact start time and offset.
    expect(new Set(run.map((start) => start.when)).size).toBe(1);
    expect(new Set(run.map((start) => start.offset)).size).toBe(1);
  }
  const offsets = runs.map((run) => run[0].offset);
  expect(offsets[0]).toBe(0);
  expect(offsets[1]).toBe(1);
  expect(offsets[2]).toBe(2);
  // Resuming continues from where it paused, just after 2 s.
  expect(offsets[3]).toBeGreaterThanOrEqual(2);
  expect(offsets[3]).toBeLessThan(2.5);
  // No <audio> elements: everything plays from the decoded buffers.
  expect(await page.evaluate(() => window.__audios.length)).toBe(0);
});

test("keeps streaming players in sync on low-memory devices", async ({ page, context }) => {
  // Pretend the device is so small (1 MB) that even the short test clip's
  // decoded stems (about 5 MB) would not fit: the player streams them with
  // <audio> elements and corrects drift instead.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { get: () => 0.001 });
  });
  await openApp(page);
  await separateClip(page, "Streaming", clip);
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__audios.filter((a) => a.src).length))
    .toBe(5);
  expect(await page.evaluate(() => window.__starts.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__audios[0].currentTime))
    .toBeGreaterThan(0.2);
  // Push one stem 0.2 s off; the next ticks bring it back.
  await page.evaluate(() => {
    const [, second] = window.__audios;
    second.currentTime += 0.2;
  });
  await expect.poll(() =>
    page.evaluate(() => {
      const [first, second] = window.__audios;
      return Math.abs(second.currentTime - first.currentTime);
    }), { timeout: 3000 }).toBeLessThan(0.05);
});

test("warns about a long track on a low-memory device", async ({ page, context }) => {
  // Pretend to be a device with 256 MB of memory: even the short test clip
  // is then too long for it.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { get: () => 0.25 });
  });
  await openApp(page);
  await createProjectWithClip(page, "Low memory", clip);
  await page.click('[data-action="separate"]');
  await expect(page.locator(".message span").first()).toHaveText(
    /This track is long for this device/,
  );
  // The warning goes away once the separation succeeds.
  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({
    timeout: SEPARATION_TIMEOUT,
  });
  await expect(page.getByText("This track is long for this device")).toHaveCount(0);
});

test("rejects a tampered model and caches nothing", async ({ page, context }) => {
  await context.route("**/models/fp16/vocals.fp16.onnx", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    body[1000] ^= 0xff;
    await route.fulfill({ response, body });
  });
  await openApp(page);
  await createProjectWithClip(page, "Tampered", clip);
  await page.click('[data-action="separate"]');
  // Shown both as the page message and as the project's error.
  await expect(page.locator(".message span").first()).toContainText(
    "corrupted (checksum mismatch)",
    { timeout: SEPARATION_TIMEOUT },
  );
  const modelKeys = await readStore<string>(page, "models", "keys");
  expect(modelKeys.filter((key) => key.startsWith("fp16/vocals"))).toEqual([]);
});

test("a second tab sees a separation running in the first", async ({ page, context }) => {
  await openApp(page);
  await createProjectWithClip(page, "Two tabs", clip);
  await page.click('[data-action="separate"]');
  await expect(page.locator(".progress-copy span").first()).toHaveText(
    /Downloading|Loading|Separating/,
  );

  const second = await context.newPage();
  await openApp(second);
  const button = second.locator(".process-card .button.primary");
  await expect(button).toHaveText("Processing in another tab…");
  await expect(button).toBeDisabled();

  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({
    timeout: SEPARATION_TIMEOUT,
  });
  const statuses = (await readStore<{ status: string }>(page, "projects"))
    .map((project) => project.status);
  expect(statuses).toEqual(["ready"]);
});
