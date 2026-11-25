import { expect, test } from "@playwright/test";
import { openApp, readStore, separateClip, writeTestClip } from "./helpers";

// The practice view's layouts: tabs and sheets on a phone, the mixer as a
// panel that opens and closes on a narrow desktop window.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  writeTestClip(clip, 8, 120, { chords: true });
});

test("phone: chart and mixer tabs, sheets from the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await separateClip(page, "Pocket practice", clip);
  const chart = page.locator("#chord-chart");
  const mixer = page.locator("#mixer");
  await expect(chart).toBeVisible();
  await expect(mixer).toBeHidden();
  await expect(page.locator(".bar-cell").first()).toBeVisible({ timeout: 60_000 });

  const tabs = page.getByRole("navigation", { name: "Views" });
  await tabs.getByRole("button", { name: "Mixer" }).click();
  await expect(mixer).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(tabs.getByRole("button", { name: "Mixer" })).toHaveAttribute("aria-current", "page");
  // The mixer takes the width of the screen, under the header.
  const mixerBox = (await mixer.boundingBox())!;
  expect(mixerBox.width).toBeGreaterThan(350);
  const headerBox = (await page.locator(".practice-header").boundingBox())!;
  expect(mixerBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  const solo = mixer.locator('[data-action="solo"][data-stem="vocals"]');
  const soloBox = (await solo.boundingBox())!;
  expect(soloBox.x + soloBox.width).toBeLessThanOrEqual(390);
  await tabs.getByRole("button", { name: "Chords" }).click();
  await expect(chart).toBeVisible();

  // Speed opens as a sheet across the bottom; the backdrop closes it.
  await page.locator('[data-action="panel"][data-panel="speed"]').click();
  const sheet = page.locator("#panel-speed");
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(389);
  expect(box.y + box.height).toBeGreaterThan(840);
  await page.mouse.click(195, 40);
  await expect(sheet).toBeHidden();
  // Back closes a sheet, staying in the project.
  await page.locator('[data-action="panel"][data-panel="speed"]').click();
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(sheet).toBeHidden();
  await expect(page.locator("h1")).toHaveText("Pocket practice");

  // Export from its tab; Rhythm from the line under the title.
  await tabs.getByRole("button", { name: "Export" }).click();
  await expect(page.locator("#panel-export")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#panel-export")).toBeHidden();
  await page.getByRole("button", { name: "Rhythm settings" }).first().click();
  await expect(page.locator("#panel-rhythm")).toBeVisible();
  await page.keyboard.press("Escape");

  // A long press on the click button opens Rhythm too.
  const click = page.locator('[data-action="click-button"]');
  const clickBox = (await click.boundingBox())!;
  await page.mouse.move(clickBox.x + clickBox.width / 2, clickBox.y + clickBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator("#panel-rhythm")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("narrow desktop: the mixer opens and closes over the chart", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await openApp(page);
  await separateClip(page, "Narrow practice", clip);
  const mixer = page.locator("#mixer");
  await expect(mixer).toBeHidden();
  const toggle = page.locator('.practice-header [data-action="mixer-toggle"]');
  await toggle.click();
  await expect(mixer).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await mixer.getByRole("button", { name: "Close the mixer" }).click();
  await expect(mixer).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Popovers open beside their chips and close with a click elsewhere.
  await page.locator('[data-action="panel"][data-panel="key"]').click();
  await expect(page.locator("#panel-key")).toBeVisible();
  await page.locator("h1").click();
  await expect(page.locator("#panel-key")).toBeHidden();
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("long press on a bar, then drag, sets a loop", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch drags go through the DevTools protocol");
    await openApp(page);
    await separateClip(page, "Touch loop", clip);
    const cells = page.locator(".bar-cell");
    await expect(cells.nth(2)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".hint-touch")).toBeVisible();
    const center = async (index: number) => {
      const box = (await cells.nth(index).boundingBox())!;
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    };
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, point?: { x: number; y: number }) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });

    // A quick drag doesn't loop.
    const start = await center(0);
    await touch("touchStart", start);
    await touch("touchMove", { x: start.x + 40, y: start.y });
    await touch("touchEnd");

    // A long press, then a drag over three bars, loops them.
    await touch("touchStart", start);
    await page.waitForTimeout(700);
    await expect(cells.nth(0)).toHaveClass(/in-loop/);
    const middle = await center(1);
    await touch("touchMove", middle);
    const end = await center(2);
    await touch("touchMove", end);
    await expect(page.locator(".bar-cell.in-loop")).toHaveCount(3);
    await touch("touchEnd");
    type Loop = { start: number; end: number; enabled: boolean };
    const savedLoop = async () => (await readStore<{ loop?: Loop }>(page, "projects"))[0]?.loop;
    await expect.poll(async () => (await savedLoop())?.enabled).toBe(true);
    const loop = (await savedLoop())!;
    expect(loop.enabled).toBe(true);
    expect(loop.start).toBeLessThan(0.1);
    expect(loop.end).toBeGreaterThan(5.8);
    expect(loop.end).toBeLessThan(6.2);
    await expect(page.locator(".bar-cell.in-loop")).toHaveCount(3);
    await expect(page.locator(".bar-cell.loop-end")).toHaveAttribute("data-index", "2");
  });
});
