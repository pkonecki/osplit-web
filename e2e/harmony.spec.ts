import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { instrument, openApp, readStore, separateClip, writeTestClip } from "./helpers";

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("chords.wav");
  // C, G, Am, F, a bar each at 120 BPM (2 s a bar), twice, over drums.
  writeTestClip(clip, 16, 120, { chords: true });
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(instrument);
});

interface SavedAnalysis {
  algorithmVersion: number;
  key?: { tonic: number; mode: string; alternative: { tonic: number; mode: string } } | null;
  keyOverride?: { tonic: number; mode: string };
  chords?: { start: number; end: number; root: number | null; quality: string }[];
  edits?: { beatsPerBar?: number };
}

const analysis = async (page: Page) =>
  (await readStore<SavedAnalysis>(page, "analysis"))[0];

async function press(page: Page, key: string): Promise<void> {
  await page.locator("h1").click();
  await page.keyboard.press(key);
}

const boxLabels = (page: Page) => page.locator(".chord-box").allTextContents();

test("detects the key and chords, names them with the key shift, exports them", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Chords", clip);
  const chip = page.locator("#key-chip");
  await expect(chip).toHaveText(/^(C major|A minor)$/, { timeout: 60_000 });
  const stored = await analysis(page);
  expect(stored.algorithmVersion).toBe(2);
  expect(stored.chords!.length).toBeGreaterThan(2);
  const original = (await chip.textContent())!;

  // The lane has a box per chord; the pad's chords are among them.
  await expect(page.locator(".chord-box").first()).toBeVisible();
  const labels = await boxLabels(page);
  for (const name of ["C", "G", "F"]) expect(labels).toContain(name);
  await expect(page.locator("#chord-current")).not.toHaveText("");

  // Up two semitones: the key and chords are named as heard.
  await press(page, ".");
  await press(page, ".");
  const shifted = original === "C major" ? "D major" : "B minor";
  await expect(chip).toHaveText(`${original} → ${shifted} (+2)`);
  await expect.poll(() => boxLabels(page)).toContain("D");
  expect(await boxLabels(page)).not.toContain("F");
  await expect(page.locator('[data-action="key-step"][data-step="1"]'))
    .toHaveAttribute("aria-label", /to (Eb major|C minor)/);

  // The panel: show the chords as written, override the key.
  await chip.click();
  await expect(page.locator("#key-panel")).toBeVisible();
  await expect(page.locator("#key-status")).toContainText("Detected");
  await page.click('[data-action="chord-names"][data-names="original"]');
  await expect.poll(() => boxLabels(page)).toContain("F");
  await page.locator("#key-select").selectOption("9:minor");
  await expect(chip).toHaveText("A minor → B minor (+2)");
  await expect.poll(async () => (await analysis(page)).keyOverride).toEqual({ tonic: 9, mode: "minor" });

  // A chord sheet in bars, named as shown (original), and a .lab file.
  let download = page.waitForEvent("download");
  await page.click('[data-action="export-chords"][data-format="txt"]');
  let file = await download;
  expect(file.suggestedFilename()).toBe("Chords-chords.txt");
  const sheet = readFileSync(await file.path(), "utf8");
  expect(sheet).toContain("Key: A minor\n");
  expect(sheet).toMatch(/\| C +\| G +\| Am +\| F +\|/);
  download = page.waitForEvent("download");
  await page.click('[data-action="export-chords"][data-format="lab"]');
  file = await download;
  expect(readFileSync(await file.path(), "utf8")).toMatch(/^\d+\.\d{3} \d+\.\d{3} (N|[A-G][#b]?:(maj|min))/m);

  // Clicking a chord seeks to it; double-clicking loops it.
  const box = page.locator(".chord-box").nth(2);
  await box.dblclick();
  await expect.poll(async () => (await readStore<{ loop?: { enabled: boolean } }>(page, "projects"))[0].loop?.enabled)
    .toBe(true);

  // Back to the detected key; everything survives a reload.
  await page.locator("#key-select").selectOption("");
  await expect(chip).toHaveText(`${original} → ${shifted} (+2)`);
  await page.reload();
  await expect(chip).toHaveText(`${original} → ${shifted} (+2)`);
  await expect.poll(() => boxLabels(page)).toContain("C");
});

test("an analysis from before key detection is upgraded, keeping corrections", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Upgrade", clip);
  await expect(page.locator("#key-chip")).not.toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#tempo-chip")).toContainText("BPM");
  // Make it look like an M9 record with a correction (3 beats a bar).
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("osplit-pwa");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const store = db.transaction("analysis", "readwrite").objectStore("analysis");
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const record = cursor.result!.value;
        delete record.key;
        delete record.chords;
        delete record.tuningCents;
        record.algorithmVersion = 1;
        record.edits = { beatsPerBar: 3 };
        cursor.result!.update(record).onsuccess = resolve;
      };
    });
    db.close();
  });
  await page.reload();
  // The tempo shows at once; the key arrives after analysing again.
  await expect(page.locator("#tempo-chip")).toContainText(/BPM|Analyzing/);
  await expect(page.locator("#key-chip")).toHaveText(/^(C major|A minor)$/, { timeout: 60_000 });
  const upgraded = await analysis(page);
  expect(upgraded.algorithmVersion).toBe(2);
  expect(upgraded.edits).toEqual({ beatsPerBar: 3 });
  expect(upgraded.chords!.length).toBeGreaterThan(2);
});
