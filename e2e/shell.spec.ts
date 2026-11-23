import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

// The app frame: the desktop rail, the phone headers, and moving between
// the library, a project and the settings.

test("desktop rail moves between the library, settings and a project", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  const rail = page.getByRole("navigation", { name: "Main" });
  await expect(rail).toBeVisible();
  await expect(page.locator("h1")).toHaveText("Library");
  await expect(rail.getByRole("button", { name: "Library" })).toHaveAttribute("aria-current", "page");

  await rail.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("h1")).toHaveText("Settings");
  await expect(rail.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-action="yt-update"]')).toBeVisible();

  await rail.getByRole("button", { name: "Library" }).click();
  await expect(page.locator("h1")).toHaveText("Library");

  await page.fill("#new-project-name", "Rail song");
  await page.click('[data-action="create"]');
  await expect(page.locator("h1")).toHaveText("Rail song");
  // Back buttons are for phones; the rail leads home.
  await expect(page.getByRole("button", { name: "Back to library" })).toBeHidden();
  await rail.getByRole("button", { name: "New split" }).click();
  await expect(page.locator("h1")).toHaveText("Library");
  await expect(page.locator("#new-project-name")).toBeFocused();

  // The bundled fonts load from the app itself.
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check("600 34px 'Space Grotesk'"))).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("Inter");
});

test("phone layout has page headers instead of the rail", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("h1")).toHaveText("Settings");
  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(page.locator("h1")).toHaveText("Library");

  await page.fill("#new-project-name", "Phone song");
  await page.click('[data-action="create"]');
  await expect(page.locator("h1")).toHaveText("Phone song");
  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(page.locator("h1")).toHaveText("Library");
  // No sideways scrolling at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
