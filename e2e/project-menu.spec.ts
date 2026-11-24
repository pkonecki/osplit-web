import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { addEmptyProject, openApp, openPanel, readStore, separateClip, writeTestClip } from "./helpers";

// The project menu (⋯) in the library and on a project, renaming, and the
// chord chart export with markers as headings.

test("renames a project from the library menu, by keyboard", async ({ page }) => {
  await openApp(page);
  await addEmptyProject(page, "Old name");
  await page.click('[data-action="home"]:visible');
  const more = page.getByRole("button", { name: "More actions for Old name" });
  await more.click();
  const menu = page.getByRole("menu", { name: "Old name" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  // Esc closes it, back on the button.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  await more.click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.locator("#text-dialog-input").fill("New name");
  await page.keyboard.press("Enter");
  await expect(page.locator(".project-row strong")).toHaveText("New name");
  expect((await readStore<{ name: string }>(page, "projects"))[0].name).toBe("New name");
});

test("exports the chord chart with markers as headings; renames on the project", async ({ page }, testInfo) => {
  const clip = testInfo.outputPath("song.wav");
  writeTestClip(clip, 8, 120, { chords: true });
  await openApp(page);
  await separateClip(page, "Charted", clip);
  await expect(page.locator(".bar-cell").first()).toBeVisible({ timeout: 60_000 });
  await page.locator("h1").click();
  await page.keyboard.press("m");
  await page.locator("#marker-name").fill("Intro");
  await page.keyboard.press("Enter");
  await expect(page.locator(".section-head")).toHaveCount(1);

  // Export… in the menu opens the Export panel.
  await page.click('.practice-header [data-action="project-menu"]');
  await page.getByRole("menuitem", { name: /^Export…/ }).click();
  await expect(page.locator("#panel-export")).toBeVisible();
  await page.click('[data-action="export-what"][data-what="chords"]');
  await expect(page.locator("#chord-preview")).toContainText("[Intro]");
  const download = page.waitForEvent("download");
  await page.click('[data-action="export-run"]');
  const text = readFileSync(await (await download).path(), "utf8");
  expect(text).toMatch(/\n\[Intro\]\n\| C +\|/);

  await page.keyboard.press("Escape");
  await page.click('.practice-header [data-action="project-menu"]');
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.locator("#text-dialog-input").fill("Charted again");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("h1")).toHaveText("Charted again");
  // The stems are still there to play.
  await openPanel(page, "speed");
  await expect(page.locator("#speed-value")).toHaveText("100%");
});
