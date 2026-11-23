import { expect, test } from "@playwright/test";
import { addEmptyProject, openApp, readStore, SEPARATION_TIMEOUT, writeTestClip } from "./helpers";

// The library (order, search, filters, empty state) and New split.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("Morning Song.wav");
  writeTestClip(clip);
});

test("an empty library offers a first split", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".empty-library")).toContainText("Your library is empty");
  await page.locator(".empty-library").getByRole("button", { name: "New split" }).click();
  await expect(page.getByRole("dialog", { name: "New split" })).toBeVisible();
});

test("searches, filters and lists the last opened first", async ({ page }) => {
  await openApp(page);
  await addEmptyProject(page, "Alpha take");
  await addEmptyProject(page, "Beta take");
  await page.click('[data-action="home"]:visible');
  const names = page.locator(".project-row:visible strong");
  // Beta was opened last.
  await expect(names).toHaveText(["Beta take", "Alpha take"]);
  await page.locator(".project-row", { hasText: "Alpha take" }).locator('[data-action="open"]').first().click();
  await page.click('[data-action="home"]:visible');
  await expect(names).toHaveText(["Alpha take", "Beta take"]);

  await page.getByLabel("Search projects").fill("bet");
  await expect(names).toHaveText(["Beta take"]);
  await page.getByLabel("Search projects").fill("");
  await expect(names).toHaveCount(2);

  // Neither has been split.
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect(names).toHaveCount(0);
  await expect(page.locator(".no-results")).toBeVisible();
  await page.getByRole("button", { name: "Unfinished" }).click();
  await expect(names).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Unfinished" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".project-row").first()).toContainText("Empty");
  await expect(page.locator(".project-row").first().getByRole("button", { name: "Add audio to Alpha take" }))
    .toBeVisible();
});

test("phone library has a New split button and fits the width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await addEmptyProject(page, "Pocket take");
  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(page.locator(".fab")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator(".fab").click();
  await expect(page.getByRole("dialog", { name: "New split" })).toBeVisible();
});

test("New split makes, opens and separates a project in one step", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
  });
  await openApp(page);
  await page.locator('[data-action="new-split"]:visible').first().click();
  const dialog = page.getByRole("dialog", { name: "New split" });
  const start = dialog.getByRole("button", { name: "Split into 5 stems" });
  await expect(start).toBeDisabled();

  // A link can be typed instead of a file.
  await dialog.getByRole("button", { name: "Link" }).click();
  await expect(dialog.getByLabel("Audio or video link")).toBeFocused();
  await dialog.getByLabel("Audio or video link").fill("https://example.com/song");
  await expect(start).toBeEnabled();
  await dialog.getByRole("button", { name: "File" }).click();
  await expect(start).toBeDisabled();

  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a file" }).click();
  await (await chooser).setFiles(clip);
  // Named after the file until a name is typed.
  await expect(dialog.getByLabel("Name")).toHaveValue("Morning Song");
  await expect(dialog).toContainText("Morning Song.wav");
  await expect(dialog.getByRole("button", { name: "Choose another" })).toBeVisible();
  await start.click();

  await expect(page.locator("h1")).toHaveText("Morning Song");
  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({ timeout: SEPARATION_TIMEOUT });
  const [project] = await readStore<{ name: string; model: string; quality?: string }>(page, "projects");
  expect(project).toMatchObject({ name: "Morning Song", model: "spleeter-5" });
  expect(project.quality).toBeUndefined();

  await page.click('[data-action="home"]:visible');
  const row = page.locator(".project-row", { hasText: "Morning Song" });
  await expect(row).toContainText("Ready");
  await expect(row).toContainText("Spleeter · 5 stems");
  // A thumbnail drawn from the stems' peaks.
  await expect(row.locator(".project-thumb span")).toHaveCount(12);
});
