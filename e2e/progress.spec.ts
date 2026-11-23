import { expect, test } from "@playwright/test";
import { openApp, readStore, SEPARATION_TIMEOUT, startSplit, writeTestClip } from "./helpers";

// Splitting in progress: the steps, cancelling, and browsing the library
// while a split runs.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  writeTestClip(clip, 6);
});

test("cancels a split from the progress screen", async ({ page }) => {
  await openApp(page);
  await startSplit(page, "Cancel me", clip);
  const steps = page.locator(".split-steps li");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("Preparing audio");
  await expect(steps.nth(1)).toContainText("Getting Spleeter");
  await expect(steps.nth(3)).toContainText("Detecting tempo, beats, key and chords");
  await expect(page.locator("#progress-value")).toHaveText(/^\d+%$/);

  await page.getByRole("button", { name: "Cancel split" }).click();
  await expect(page.locator(".split-stopped")).toContainText("Split stopped");
  await expect(page.locator('[data-action="separate"]')).toHaveText("Retry separation");
  const [project] = await readStore<{ status: string }>(page, "projects");
  expect(project.status).toBe("interrupted");

  await page.click('[data-action="home"]:visible');
  const row = page.locator(".project-row", { hasText: "Cancel me" });
  await expect(row).toContainText("Interrupted");
  // Resume starts it again from the library.
  await row.getByRole("button", { name: "Resume Cancel me" }).click();
  await expect(page.locator("h1")).toHaveText("Cancel me");
  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({ timeout: SEPARATION_TIMEOUT });
});

test("the library shows a split running in the background", async ({ page }) => {
  await openApp(page);
  await startSplit(page, "Background", clip);
  await expect(page.locator("#progress-card")).toBeVisible();
  // Leaving the project doesn't stop the split.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Library" }).click();
  await expect(page.locator("h1")).toHaveText("Library");
  const row = page.locator(".project-row", { hasText: "Background" });
  await expect(row.locator(".status-text")).toHaveText(/Separating · \d+%/);
  // A second split waits for this one.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "New split" }))
    .toHaveAttribute("aria-disabled", "true");
  // The project can't be deleted while it is split.
  await row.getByRole("button", { name: "Delete Background" }).click();
  await expect(page.locator(".message span")).toContainText("Cancel the split first");

  await row.getByRole("button", { name: "Open Background" }).click();
  await expect(page.locator("#progress-card")).toBeVisible();
  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({ timeout: SEPARATION_TIMEOUT });
  expect((await readStore<{ status: string }>(page, "projects"))[0].status).toBe("ready");
});

test("progress screen fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await startSplit(page, "Pocket split", clip);
  await expect(page.locator("#progress-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel split" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Cancel split" }).click();
  await expect(page.locator(".split-stopped")).toBeVisible();
});
