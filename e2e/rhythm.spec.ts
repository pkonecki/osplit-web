import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  closePanel,
  instrument,
  openApp,
  openPanel,
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
  if (await page.locator(".panel:visible").count()) await closePanel(page);
  await page.locator("h1").click();
  await page.keyboard.press(key);
}

const position = (page: Page) => page.locator("#seek-bar").inputValue().then(Number);

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
  await expect(page.locator("#metre-chip")).toHaveText("4/4");

  // The chart shows the bars: 2 s each.
  const cells = page.locator(".bar-cell");
  expect(await cells.count()).toBeGreaterThanOrEqual(4);

  // The click row appears, off until turned on; the player's click button,
  // the mixer's M and Rhythm's switch are one state.
  const clickRow = page.locator('[data-stem-row="click"]');
  const clickMute = clickRow.locator('[data-action="mute"]');
  const clickButton = page.locator('[data-action="click-button"]');
  await expect(clickRow).toBeVisible();
  await expect(clickMute).toHaveAttribute("aria-pressed", "true");
  await expect(clickButton).toHaveAttribute("aria-pressed", "false");
  await clickButton.click();
  await expect(clickMute).toHaveAttribute("aria-pressed", "false");
  await expect(clickButton).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await project(page)).clickOn).toBe(true);
  await openPanel(page, "rhythm");
  await expect(page.locator('#panel-rhythm [data-action="click-toggle"]')).toBeChecked();
  await page.locator('#panel-rhythm [data-action="click-toggle"]').uncheck();
  await expect(clickMute).toHaveAttribute("aria-pressed", "true");
  await clickMute.click();
  await openPanel(page, "rhythm");
  await expect(page.locator('#panel-rhythm [data-action="click-toggle"]')).toBeChecked();
  // One volume too: the slider in Rhythm moves the mixer's.
  await page.locator('#panel-rhythm [data-action="volume"][data-stem="click"]').fill("0.4");
  await expect(clickRow.locator('[data-action="volume"]')).toHaveValue("0.4");
  await expect(clickRow.locator("[data-volume-label]")).toHaveText("40%");
  await closePanel(page);

  // Playing schedules a click on each beat, besides the five stems.
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__starts.length), { timeout: 5000 })
    .toBeGreaterThan(5 + 2);
  await expect(page.locator("#bar-label")).toContainText("Bar");
  await page.click('[data-action="play"]');

  // Bars: a click seeks to the bar, the buttons and ← / → step a bar.
  await cells.nth(2).click();
  const third = await position(page);
  expect(third).toBeGreaterThan(3.5);
  expect(third).toBeLessThan(4.5);
  await expect(cells.nth(2)).toHaveAttribute("aria-current", "true");
  await page.click('[data-action="bar-step"][data-step="1"]');
  await expect.poll(() => position(page)).toBeCloseTo(third + 2, 0);
  await press(page, "ArrowLeft");
  await expect.poll(() => position(page)).toBeCloseTo(third, 0);

  // One bar from the playhead: 2 s at 120 BPM in 4/4.
  await seekTo(page, 4.6);
  await openPanel(page, "loop");
  await page.click('[data-action="loop-bars"][data-bars="1"]');
  await expect.poll(async () => (await project(page)).loop?.enabled).toBe(true);
  let loop = (await project(page)).loop!;
  expect(loop.end - loop.start).toBeGreaterThan(1.9);
  expect(loop.end - loop.start).toBeLessThan(2.1);
  expect(loop.start).toBeLessThanOrEqual(4.6);
  expect(loop.end).toBeGreaterThan(4.6);
  await expect(page.locator("#loop-chip-value")).toHaveText("1 bar");
  await page.click('[data-action="loop-bars"][data-bars="2"]');
  await expect(page.locator("#loop-chip-value")).toHaveText("2 bars");
  await page.click('[data-action="loop-clear"]');
  await closePanel(page);

  // Shift-click on a bar loops from the bar playing to it.
  await cells.nth(0).click();
  await cells.nth(2).click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await project(page)).loop?.enabled).toBe(true);
  loop = (await project(page)).loop!;
  expect(loop.end - loop.start).toBeGreaterThan(5.8);
  expect(loop.end - loop.start).toBeLessThan(6.2);

  // Corrections: ×2, ÷2, beats per bar; saved with the analysis.
  await page.locator("#tempo-chip").click();
  await expect(page.locator("#panel-rhythm")).toBeVisible();
  await expect(page.locator("#tempo-status")).toContainText("Detected in the drums");
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
  await expect(page.locator("#metre-chip")).toHaveText("3/4");
  await page.click('[data-action="tempo-downbeat"][data-step="1"]');
  await expect(page.locator("#downbeat-label")).toHaveText("1 beat later than detected");
  // The speed changes the tempo heard.
  await page.click('[data-action="tempo-reset"]');
  await expect.poll(async () => (await analysis(page)).edits).toEqual({});
  await openPanel(page, "speed");
  await page.locator("#speed").fill("50");
  await expect(page.locator("#tempo-chip")).toContainText(`${tempo} → ${Math.round(tempo / 2)}`);
  await expect(page.locator("#speed-bpm")).toHaveText(`${Math.round(tempo / 2)} BPM · original ${tempo}`);

  // Grid and click survive a reload, without analysing again.
  await page.reload();
  await expect(page.locator("#tempo-chip")).toContainText("BPM");
  await expect(clickMute).toHaveAttribute("aria-pressed", "false");

  // The click can go in the zip of stems.
  await openPanel(page, "export");
  await page.click('[data-action="export-pick"][data-stem="click"]');
  const download = page.waitForEvent("download");
  await page.click('[data-action="export-run"]');
  const file = await download;
  expect(file.suggestedFilename()).toBe("Rhythm-stems.zip");
  const names = zipEntries(readFileSync(await file.path()));
  expect(names).toContain("Rhythm-click.flac");
  expect(names).toContain("Rhythm-drums.flac");

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
  const find = page.locator("#chord-chart").getByRole("button", { name: "Detect tempo, beats, key and chords" });
  await expect(find).toBeVisible();
  await expect(clickRow).toHaveCount(0);
  await find.click();
  await expect(page.locator("#tempo-chip")).toContainText("BPM", { timeout: 60_000 });
  await expect(clickRow).toBeVisible();
});

test("no beat in steady tones; tap tempo makes a grid", async ({ page }, testInfo) => {
  const tones = testInfo.outputPath("tones.wav");
  writeTestClip(tones, 4);
  await openApp(page);
  await separateClip(page, "Tones", tones);
  await expect(page.locator("#tempo-chip")).toHaveText("No beat", { timeout: 60_000 });
  await expect(page.locator('[data-stem-row="click"]')).toHaveCount(0);
  // Without a grid the click button opens Rhythm, to tap a tempo.
  await page.click('[data-action="click-button"]');
  await expect(page.locator("#panel-rhythm")).toBeVisible();
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
  await openPanel(page, "loop");
  await expect(page.locator('[data-action="loop-bars"]').first()).toBeEnabled();
  // Undoing the taps brings back "no beat".
  await openPanel(page, "rhythm");
  await page.click('[data-action="tempo-reset"]');
  await expect(page.locator("#tempo-chip")).toHaveText("No beat");
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
  await page.click('[data-action="click-button"]');
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__audios.filter((a) => a.src).length))
    .toBe(5);
  // Clicks are buffer sources scheduled alongside the streaming elements.
  await expect.poll(() => page.evaluate(() => window.__starts.length), { timeout: 5000 })
    .toBeGreaterThan(2);
  await page.click('[data-action="play"]');
  expect(errors).toEqual([]);
});
