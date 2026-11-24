import { expect, test } from "@playwright/test";
import { openApp, readStore } from "./helpers";

// Settings: storage, the separation models (download and delete ahead of
// time), WebGPU and the link downloader.

test("downloads and deletes a model, and shows storage and WebGPU", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
  });
  await openApp(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("h1")).toHaveText("Settings");
  await expect(page.locator(".status-line")).toHaveText("No WebGPU");
  await expect(page.locator('[data-action="yt-update"]')).toBeVisible();

  const spleeter = page.locator('[data-model-row="spleeter-5"]');
  await expect(spleeter).toContainText("Not downloaded");
  await expect(spleeter).toContainText("197 MB");
  await expect(page.locator('[data-model-row="htdemucs-6s"]')).toContainText("115 MB");

  await spleeter.getByRole("button", { name: "Download the Spleeter model" }).click();
  await expect(spleeter).toContainText("Downloaded", { timeout: 120_000 });
  await expect(spleeter).not.toContainText("Downloading");
  expect(await readStore<string>(page, "models", "keys")).toHaveLength(5);
  await expect(page.locator(".meter-legend")).not.toContainText("Models 0 KB");

  await spleeter.getByRole("button", { name: "Delete the Spleeter model" }).click();
  const dialog = page.locator("dialog.confirm-dialog");
  await dialog.getByRole("button", { name: "Delete model" }).click();
  await expect(spleeter).toContainText("Not downloaded");
  expect(await readStore(page, "models", "keys")).toHaveLength(0);
  await expect(page.locator(".message span")).toContainText("Deleted the Spleeter model");
});
