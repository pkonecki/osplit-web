import { expect, test } from "@playwright/test";
import { addEmptyProject, openApp } from "./helpers";

// Back and Forward move between the library, settings and projects, instead
// of leaving the app.

test("Back and Forward go between the app's pages", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await addEmptyProject(page, "Back song");
  const title = page.locator("h1");
  const rail = page.getByRole("navigation", { name: "Main" });

  // Library → project: Back returns to the library, Forward to the project.
  await page.goBack();
  await expect(title).toHaveText("Library");
  await page.goForward();
  await expect(title).toHaveText("Back song");

  // Project → settings: Back returns to the project, then the library.
  await rail.getByRole("button", { name: "Settings" }).click();
  await expect(title).toHaveText("Settings");
  await page.goBack();
  await expect(title).toHaveText("Back song");
  await page.goBack();
  await expect(title).toHaveText("Library");

  // Leaving a project from the app goes back in history: the library's entry
  // is the first again, so Back doesn't reopen the project.
  await page.locator(".project-row", { hasText: "Back song" }).locator('[data-action="open"]').first().click();
  await expect(title).toHaveText("Back song");
  await rail.getByRole("button", { name: "Library" }).click();
  await expect(title).toHaveText("Library");
  await expect.poll(() => page.evaluate(() => (history.state as { osplit?: number } | null)?.osplit)).toBe(0);

  // Reopened in a project (the last one open), Back goes to the library.
  await page.locator(".project-row", { hasText: "Back song" }).locator('[data-action="open"]').first().click();
  await expect(title).toHaveText("Back song");
  await page.reload();
  await expect(title).toHaveText("Back song");
  await page.goBack();
  await expect(title).toHaveText("Library");
});
