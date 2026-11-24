import { expect, type Page, test } from "@playwright/test";
import { openPanel, readStore, separateClip, openApp, writeTestClip, closePanel } from "./helpers";

// Markers: add at the playhead (M), headings in the chart, the list or
// strip, jumping and section loops, rename and delete, and following the
// grid when it changes.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("song.wav");
  // C, G, Am, F at 120 BPM (2 s a bar) over drums: 8 bars.
  writeTestClip(clip, 16, 120, { chords: true });
});

interface SavedProject {
  markers?: { bar: number; time: number; name: string }[];
  loop?: { start: number; end: number; enabled: boolean };
}
const saved = async (page: Page) => (await readStore<SavedProject>(page, "projects"))[0];
const position = (page: Page) => page.locator("#seek-bar").inputValue().then(Number);

async function press(page: Page, key: string): Promise<void> {
  await page.locator("h1").click();
  await page.keyboard.press(key);
}

test("adds, jumps to, loops, renames and deletes markers", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Marked song", clip);
  const cells = page.locator(".bar-cell");
  await expect(cells.first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".markers-empty")).toContainText("Mark the intro");

  // M at the start adds a marker at the first bar; a preset fills the name.
  const firstBar = Number((await cells.first().getAttribute("aria-label"))!.match(/Bar (\d+)/)![1]);
  await press(page, "m");
  const panel = page.locator("#panel-marker");
  await expect(panel).toBeVisible();
  await expect(page.locator("#marker-name")).toBeFocused();
  await expect(page.locator("#marker-start")).toHaveText(`Bar ${firstBar} · 0:00`);
  await panel.getByRole("button", { name: "Verse" }).click();
  await expect(page.locator("#marker-name")).toHaveValue("Verse");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel).toBeHidden();

  // A second one four bars later, from the Add button, named by hand.
  await cells.nth(4).click();
  await page.locator(".markers-add").click();
  await expect(page.locator("#marker-start")).toHaveText(new RegExp(`^Bar ${firstBar + 4} · 0:0[78]$`));
  await page.locator("#marker-name").fill("Chorus");
  await page.keyboard.press("Enter");
  await expect(page.locator(".section-head")).toHaveCount(2);
  await expect(page.locator(".section-head").nth(1)).toContainText(`Chorus`);
  await expect(page.locator(".section-head").first()).toContainText(`Bars ${firstBar}–${firstBar + 3}`);
  const items = page.locator(".marker-item");
  await expect(items).toHaveCount(2);
  await expect(page.locator(".scrub-tick")).toHaveCount(2);
  expect((await saved(page)).markers).toEqual([
    { bar: firstBar, time: expect.any(Number), name: "Verse" },
    { bar: firstBar + 4, time: expect.any(Number), name: "Chorus" },
  ]);
  // The player names the section playing.
  await expect(page.locator("#section-label")).toHaveText("Chorus");

  // Jump, and Shift+← / Shift+→ between markers.
  await items.first().getByRole("button", { name: "Jump to Verse" }).click();
  await expect.poll(() => position(page)).toBeLessThan(0.1);
  await press(page, "Shift+ArrowRight");
  await expect.poll(() => position(page)).toBeCloseTo(8, 0);
  await press(page, "Shift+ArrowLeft");
  await expect.poll(() => position(page)).toBeLessThan(0.1);

  // Looping a section: from its bar to the bar before the next marker.
  await page.locator('.section-head [data-action="marker-loop"]').first().click();
  await expect.poll(async () => (await saved(page)).loop?.enabled).toBe(true);
  const loop = (await saved(page)).loop!;
  expect(loop.start).toBeLessThan(0.1);
  expect(loop.end).toBeCloseTo(8, 0);
  await expect(page.locator('.section-head [data-action="marker-loop"]').first()).toHaveAttribute("aria-pressed", "true");
  // Again turns it off.
  await page.locator('.section-head [data-action="marker-loop"]').first().click();
  await expect.poll(async () => (await saved(page)).loop?.enabled).toBe(false);

  // Right-click a heading: rename, or delete.
  await page.locator(".section-head .section-jump").nth(1).click({ button: "right" });
  await page.getByRole("button", { name: "Rename" }).click();
  await page.locator("#text-dialog-input").fill("Chorus 1");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".section-head").nth(1)).toContainText("Chorus 1");
  await page.locator(".section-head .section-jump").first().click({ button: "right" });
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".section-head")).toHaveCount(1);
  expect((await saved(page)).markers?.map((marker) => marker.name)).toEqual(["Chorus 1"]);

  // Tempo ×2 halves the bars: the marker stays at its time, now a later bar.
  await openPanel(page, "rhythm");
  await page.click('[data-action="tempo-factor"][data-factor="2"]');
  await closePanel(page);
  await expect.poll(async () => (await saved(page)).markers?.[0].bar).toBeGreaterThan(firstBar + 4);
  await expect(page.locator(".section-head")).toContainText("Chorus 1");
});

test("phone: the marker strip and a long press on a heading", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await separateClip(page, "Pocket marks", clip);
  await expect(page.locator(".bar-cell").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Add marker" }).click();
  const sheet = page.locator("#panel-marker");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Intro" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  const strip = page.getByRole("navigation", { name: "Markers" });
  await expect(strip.getByRole("button", { name: "Jump to Intro" })).toBeVisible();

  // Touch long press on the heading opens Rename / Delete.
  const head = page.locator(".section-head .section-jump").first();
  const box = (await head.boundingBox())!;
  await head.dispatchEvent("pointerdown", { pointerType: "touch", clientX: box.x + 5, clientY: box.y + 5 });
  await page.waitForTimeout(700);
  await head.dispatchEvent("pointerup", { pointerType: "touch" });
  await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".section-head")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
