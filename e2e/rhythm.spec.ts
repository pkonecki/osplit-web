import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  instrument,
  openApp,
  readStore,
  seekTo,
  separateClip,
  writeTestClip,
} from "./helpers";

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("rhythm.wav");
  // A drum pattern at 120 BPM: a bar lasts 2 s.
  writeTestClip(clip, 10, 120);
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(instrument);
});

interface SavedAnalysis {
  bpm: number;
  bpmConfidence: number;
  beats: Float32Array;
  beatsPerBar: number;
  edits?: { bpmFactor?: number; beatsPerBar?: number; downbeatShift?: number };
}

interface SavedProject {
  clickOn?: boolean;
  loop?: { start: number; end: number; enabled: boolean };
}

const analysis = async (page: Page) =>
  (await readStore<SavedAnalysis>(page, "analysis"))[0];
const project = async (page: Page) =>
  (await readStore<SavedProject>(page, "projects"))[0];

/** The tempo the chip shows, e.g. 120 for "♩ 120 BPM". */
async function chipTempo(page: Page): Promise<number> {
  const text = (await page.locator("#tempo-chip").textContent()) ?? "";
  return Number(text.match(/(\d+)\??\s*BPM/)?.[1] ?? NaN);
}

async function press(page: Page, key: string): Promise<void> {
  await page.locator("h1").click();
  await page.keyboard.press(key);
}

/** Zip entry names from a downloaded zip. */
function zipEntries(bytes: Buffer): string[] {
  const end = bytes.length - 22;
  const names: string[] = [];
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    names.push(bytes.subarray(offset + 46, offset + 46 + nameLength).toString());
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  return names;
}

test("finds the tempo, plays the click and loops bars", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Rhythm", clip);

  // The analysis runs after separation and is stored with the project.
  await expect(page.locator("#tempo-chip")).toContainText("BPM", { timeout: 60_000 });
  const tempo = await chipTempo(page);
  expect(tempo).toBeGreaterThanOrEqual(119);
  expect(tempo).toBeLessThanOrEqual(121);
  const stored = await analysis(page);
  expect(stored.bpm).toBeGreaterThan(119);
  expect(stored.bpm).toBeLessThan(121);
  expect(stored.bpmConfidence).toBeGreaterThanOrEqual(0.3);
  expect(stored.beats.length).toBeGreaterThan(15);

  // The click row appears, off until turned on (C).
  const clickRow = page.locator('[data-stem-row="click"]');
  await expect(clickRow).toBeVisible();
  await expect(clickRow.locator('[data-action="mute"]')).toHaveClass(/muted/);
  await press(page, "c");
  await expect(clickRow.locator('[data-action="mute"]')).not.toHaveClass(/muted/);
  await expect.poll(async () => (await project(page)).clickOn).toBe(true);

  // Playing schedules a click on each beat, besides the five stems.
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__starts.length), { timeout: 5000 })
    .toBeGreaterThan(5 + 2);
  await page.click('[data-action="play"]');

  // One bar from the playhead: 2 s at 120 BPM in 4/4.
  await seekTo(page, 4.6);
  await page.click('[data-action="loop-bars"][data-bars="1"]');
  await expect.poll(async () => (await project(page)).loop?.enabled).toBe(true);
  let loop = (await project(page)).loop!;
  expect(loop.end - loop.start).toBeGreaterThan(1.9);
  expect(loop.end - loop.start).toBeLessThan(2.1);
  expect(loop.start).toBeLessThanOrEqual(4.6);
  expect(loop.end).toBeGreaterThan(4.6);
  // B on a bar loop doubles it.
  await press(page, "b");
  await expect.poll(async () => {
    const current = (await project(page)).loop!;
    return current.end - current.start;
  }).toBeGreaterThan(3.8);
  loop = (await project(page)).loop!;
  expect(loop.end - loop.start).toBeLessThan(4.2);

  // Dragging a loop across the ruler snaps its edges to beats; Shift doesn't.
  const beats = Array.from(stored.beats);
  const nearestBeat = (time: number) =>
    beats.reduce((best, beat) => Math.abs(beat - time) < Math.abs(best - time) ? beat : best);
  const ruler = page.locator(".loop-ruler");
  await ruler.scrollIntoViewIfNeeded();
  const box = (await ruler.boundingBox())!;
  const y = box.y + box.height / 2;
  const drag = async (from: number, to: number) => {
    await page.mouse.move(box.x + box.width * from, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (from + to) / 2, y, { steps: 4 });
    await page.mouse.move(box.x + box.width * to, y, { steps: 4 });
    await page.mouse.up();
  };
  await drag(0.33, 0.61);
  await expect.poll(async () => (await project(page)).loop?.start)
    .toBeCloseTo(nearestBeat(3.3), 2);
  expect((await project(page)).loop?.end).toBeCloseTo(nearestBeat(6.1), 2);
  await page.keyboard.down("Shift");
  await drag(0.33, 0.61);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await project(page)).loop?.start).toBeCloseTo(3.3, 1);
  expect(Math.abs((await project(page)).loop!.start - nearestBeat(3.3))).toBeGreaterThan(0.1);

  // Corrections: ×2, ÷2, beats per bar; saved with the analysis.
  await page.click("#tempo-chip");
  await expect(page.locator("#tempo-panel")).toBeVisible();
  await expect(page.locator("#tempo-status")).toContainText("Detected 120 BPM");
  await page.click('[data-action="tempo-factor"][data-factor="2"]');
  await expect.poll(() => chipTempo(page)).toBe(tempo * 2);
  await expect(page.locator('[data-action="tempo-factor"][data-factor="2"]')).toBeDisabled();
  await page.click('[data-action="tempo-factor"][data-factor="0.5"]');
  await page.click('[data-action="tempo-factor"][data-factor="0.5"]');
  await expect.poll(() => chipTempo(page)).toBe(Math.round(tempo / 2));
  await expect.poll(async () => (await analysis(page)).edits?.bpmFactor).toBe(0.5);
  await page.click('[data-action="tempo-metre"][data-beats="3"]');
  await expect(page.locator('[data-action="tempo-metre"][data-beats="3"]'))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await analysis(page)).edits?.beatsPerBar).toBe(3);
  // The speed changes the tempo heard.
  await page.click('[data-action="tempo-reset"]');
  await expect.poll(async () => (await analysis(page)).edits).toEqual({});
  await page.locator("#speed").fill("50");
  await expect(page.locator("#tempo-chip")).toContainText(`${tempo} → ${Math.round(tempo / 2)}`);

  // Grid and click survive a reload, without analysing again.
  await page.reload();
  await expect(page.locator("#tempo-chip")).toContainText("BPM");
  await expect(clickRow.locator('[data-action="mute"]')).not.toHaveClass(/muted/);

  // Export all adds the click track.
  const download = page.waitForEvent("download");
  await page.click('[data-action="export-all"]');
  const names = zipEntries(readFileSync(await (await download).path()));
  expect(names).toContain("Rhythm-click.flac");
  expect(names).toContain("Rhythm-mix.flac");

  // A project without an analysis (separated before M9) offers to find it.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("osplit-pwa");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("analysis", "readwrite");
      tx.objectStore("analysis").clear();
      tx.oncomplete = resolve;
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator("#tempo-chip")).toHaveText("Find tempo");
  await expect(clickRow).toHaveCount(0);
  await page.click("#tempo-chip");
  await expect(page.locator("#tempo-chip")).toContainText("BPM", { timeout: 60_000 });
  await expect(clickRow).toBeVisible();
});

test("no beat in steady tones; tap tempo makes a grid", async ({ page }, testInfo) => {
  const tones = testInfo.outputPath("tones.wav");
  writeTestClip(tones, 4);
  await openApp(page);
  await separateClip(page, "Tones", tones);
  await expect(page.locator("#tempo-chip")).toHaveText("No beat found", { timeout: 60_000 });
  await expect(page.locator('[data-stem-row="click"]')).toHaveCount(0);
  await expect(page.locator('[data-action="loop-bars"]').first()).toBeDisabled();
  await page.click("#tempo-chip");
  await expect(page.locator("#tempo-status")).toContainText("No steady beat");

  // Five taps half a second apart: 120 BPM, with a beat on the last tap.
  for (let i = 0; i < 5; i++) {
    if (i) await page.waitForTimeout(500);
    await page.click('[data-action="tempo-tap"]');
  }
  await expect(page.locator("#tempo-chip")).toContainText("BPM");
  const tapped = (await analysis(page)).edits as { tapped?: { bpm: number } };
  expect(tapped.tapped!.bpm).toBeGreaterThan(110);
  expect(tapped.tapped!.bpm).toBeLessThan(130);
  await expect(page.locator('[data-stem-row="click"]')).toBeVisible();
  await expect(page.locator('[data-action="loop-bars"]').first()).toBeEnabled();
  // Undoing the taps brings back "no beat".
  await page.click('[data-action="tempo-reset"]');
  await expect(page.locator("#tempo-chip")).toHaveText("No beat found");
  await expect(page.locator('[data-stem-row="click"]')).toHaveCount(0);
});

test("click with streaming playback", async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { get: () => 0.001 });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openApp(page);
  await separateClip(page, "Streaming rhythm", clip);
  await expect(page.locator("#tempo-chip")).toContainText("BPM", { timeout: 60_000 });
  await press(page, "c");
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__audios.filter((a) => a.src).length))
    .toBe(5);
  // Clicks are buffer sources scheduled alongside the streaming elements.
  await expect.poll(() => page.evaluate(() => window.__starts.length), { timeout: 5000 })
    .toBeGreaterThan(2);
  await page.click('[data-action="play"]');
  expect(errors).toEqual([]);
});
