import { expect, type Page, test } from "@playwright/test";
import { closePanel, instrument, openApp, openPanel, readStore, separateClip, writeTestClip } from "./helpers";

// Time signatures, the accent switch, subdivisions, the count-in and capo.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("song.wav");
  // C, G, Am, F at 120 BPM over drums.
  writeTestClip(clip, 12, 120, { chords: true });
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(instrument);
});

interface Saved {
  clickAccent?: boolean;
  clickSubdivision?: number;
  countInBars?: number;
  capo?: number;
}
const saved = async (page: Page) => (await readStore<Saved>(page, "projects"))[0];
const position = (page: Page) => page.locator("#seek-bar").inputValue().then(Number);
const chartLabels = (page: Page) => page.locator(".bar-cell .bar-chord span").allTextContents();

test("time signature, accent, subdivision and count-in", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Extras", clip);
  await expect(page.locator("#tempo-chip")).toContainText("BPM", { timeout: 60_000 });
  await openPanel(page, "rhythm");

  // 6/8 by hand.
  await page.click('[data-action="tempo-metre"][data-beats="6"][data-unit="8"]');
  await expect(page.locator("#metre-chip")).toHaveText("6/8");
  await expect(page.locator("#beat-cells span")).toHaveCount(6);
  await expect.poll(async () => (await readStore<{ edits?: object }>(page, "analysis"))[0].edits)
    .toEqual({ metre: { beats: 6, unit: 8 } });
  await page.click('[data-action="tempo-metre"][data-beats="4"][data-unit="4"]');

  // The accent and subdivision are saved with the project.
  await page.locator('[data-action="click-accent"]').uncheck();
  await expect.poll(async () => (await saved(page)).clickAccent).toBe(false);
  await expect(page.locator("#beat-cells .accent")).toHaveCount(0);
  await page.click('[data-action="click-sub"][data-sub="2"]');
  await expect.poll(async () => (await saved(page)).clickSubdivision).toBe(2);
  await expect(page.locator('[data-action="click-sub"][data-sub="2"]')).toHaveAttribute("aria-pressed", "true");

  // Count-in: a bar of clicks (2 s at 120 BPM) before the stems start.
  await page.click('[data-action="count-in"][data-bars="1"]');
  await expect.poll(async () => (await saved(page)).countInBars).toBe(1);
  await closePanel(page);
  await page.evaluate(() => {
    window.__starts = [];
    window.__earlyStops = [];
  });
  await page.click('[data-action="play"]');
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Stop the count-in");
  await page.waitForTimeout(1000);
  expect(await position(page)).toBe(0);
  // Count-in clicks (4 beats, 8ths: 8) play although the click is off.
  expect((await page.evaluate(() => window.__starts.length))).toBeGreaterThanOrEqual(8);
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Pause", { timeout: 5000 });
  // None of them was cut off before it played: every beat of the bar is heard.
  expect(await page.evaluate(() => window.__earlyStops)).toEqual([]);
  await expect.poll(() => position(page)).toBeGreaterThan(0.2);
  await page.click('[data-action="play"]');
});

test("capo names the shapes played with it", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Capo song", clip);
  await expect(page.locator(".bar-cell").first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => chartLabels(page)).toContain("Am");
  await openPanel(page, "capo");
  // F is a barre chord; with the capo on 5, C G Am F are G D Em C, all open.
  await expect(page.locator(".capo-suggestion").first()).toContainText("Capo 5");
  await expect(page.locator(".capo-suggestion").first()).toContainText("100% open");
  await page.click('[data-action="capo-step"][data-step="1"]');
  await page.click('[data-action="capo-step"][data-step="1"]');
  await page.click('[data-action="capo-step"][data-step="1"]');
  await expect(page.locator("#capo-value")).toHaveText("3");
  await expect(page.locator("#capo-chip")).toHaveText("Capo 3");
  await expect(page.locator("#capo-chip-value")).toHaveText("3");
  // Each chord down three semitones: C → A, G → E, Am → F#m, F → D.
  await expect.poll(() => chartLabels(page)).toContain("F#m");
  const labels = await chartLabels(page);
  expect(labels).toContain("E");
  expect(labels).not.toContain("Am");
  await expect(page.locator(".capo-pair").first()).toContainText(/[A-G]/);
  expect((await saved(page)).capo).toBe(3);
  // The audio doesn't change.
  await expect(page.locator("#speed-chip-value")).toHaveText("100%");
  await page.click('[data-action="capo-reset"]');
  await expect.poll(() => chartLabels(page)).toContain("Am");
});
