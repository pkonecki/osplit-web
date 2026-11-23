import { expect, type Page, test } from "@playwright/test";
import { createProjectWithClip, openApp, writeTestClip } from "./helpers";

// Headless Chromium in CI has no WebGPU adapter, so Demucs is unavailable
// there. The "available" cases replace navigator.gpu on the page with a stub:
// they test the model choice, not a Demucs separation, which needs a real
// GPU (see docs/htdemucs-6s-plan.md).

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  writeTestClip(clip);
});

/** Makes the page see a WebGPU adapter, with or without shader-f16. */
async function stubGpu(page: Page, f16: boolean): Promise<void> {
  await page.addInitScript((f16) => {
    const adapter = { features: new Set(f16 ? ["shader-f16"] : []) };
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter: () => Promise.resolve(adapter) },
    });
  }, f16);
}

const status = (page: Page) => page.locator(".gpu-status");
const spleeter = (page: Page) => page.locator('[data-action="model"][data-model="spleeter-5"]');
const demucs = (page: Page) => page.locator('[data-action="model"][data-model="htdemucs-6s"]');

/** The New split dialog, opened from the library. */
async function newSplit(page: Page) {
  await page.locator('[data-action="new-split"]:visible').first().click();
  const dialog = page.getByRole("dialog", { name: "New split" });
  await expect(dialog).toBeVisible();
  return {
    dialog,
    spleeter: dialog.getByRole("radio", { name: /Spleeter/ }),
    demucs: dialog.getByRole("radio", { name: /Demucs/ }),
    start: dialog.getByRole("button", { name: /^Split into/ }),
  };
}

test("offers only Spleeter without WebGPU", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
  });
  await openApp(page);
  const split = await newSplit(page);
  await expect(split.spleeter).toHaveAttribute("aria-checked", "true");
  await expect(split.demucs).toBeDisabled();
  await expect(split.demucs).toContainText("Needs WebGPU, which this browser doesn't offer");
  await expect(split.spleeter).toContainText("197 MB");
  await expect(split.start).toHaveText("Split into 5 stems");
  // Nothing to split until there is audio.
  await expect(split.start).toBeDisabled();
  await page.keyboard.press("Escape");

  await createProjectWithClip(page, "No GPU", clip);
  await expect(status(page)).toHaveText(
    "WebGPU: not available – separation runs on the CPU",
  );
  await expect(spleeter(page)).toHaveClass(/selected/);
  await expect(demucs(page)).toBeDisabled();
  await expect(page.locator('[data-action="separate"]')).toHaveText("Separate five stems");
});

test("offers Demucs without FP16 shaders (the model is FP32)", async ({ page }) => {
  await stubGpu(page, false);
  await openApp(page);
  const split = await newSplit(page);
  await expect(split.demucs).toHaveAttribute("aria-checked", "true");
  await expect(split.demucs).toBeEnabled();
  await expect(split.demucs).toContainText("available on this device");
});

test("defaults to Demucs with WebGPU and says it is slower", async ({ page }) => {
  await stubGpu(page, true);
  await openApp(page);
  const split = await newSplit(page);
  await expect(split.demucs).toHaveAttribute("aria-checked", "true");
  await expect(split.demucs).toContainText("115 MB");
  await expect(split.demucs).toContainText("Slower");
  await expect(split.demucs).toContainText("Guitar");
  await expect(split.start).toHaveText("Split into 6 stems");
  await split.spleeter.click();
  await expect(split.spleeter).toHaveAttribute("aria-checked", "true");
  await expect(split.start).toHaveText("Split into 5 stems");
  // Arrow keys move the choice, as in a radio group.
  await split.spleeter.press("ArrowRight");
  await expect(split.demucs).toHaveAttribute("aria-checked", "true");
  await expect(split.demucs).toBeFocused();
  await page.keyboard.press("Escape");

  // On the project page, switching to Spleeter is saved.
  await createProjectWithClip(page, "GPU", clip, "htdemucs-6s");
  await expect(status(page)).toHaveText("WebGPU: available");
  await expect(demucs(page)).toHaveClass(/selected/);
  await expect(demucs(page)).toContainText("6 stems · better, slower · 115 MB");
  await expect(page.locator(".model-hint")).toContainText("takes longer");
  await expect(page.locator('[data-action="quality"]')).toHaveCount(0);
  await expect(page.locator('[data-action="separate"]')).toHaveText("Separate six stems");
  await spleeter(page).click();
  await expect(spleeter(page)).toHaveClass(/selected/);
  await expect(page.locator('[data-action="separate"]')).toHaveText("Separate five stems");
  // The app reopens the last project after a reload.
  await page.reload();
  await expect(spleeter(page)).toHaveClass(/selected/);
});

test("a Demucs project opened without WebGPU must switch to Spleeter to re-separate", async ({ page }) => {
  await stubGpu(page, true);
  await openApp(page);
  await createProjectWithClip(page, "Moved", clip, "htdemucs-6s");
  await expect(demucs(page)).toHaveClass(/selected/);

  const plain = await page.context().newPage();
  await plain.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
  });
  // Same browser profile: the app reopens the last project.
  await openApp(plain);
  await expect(plain.locator(".model-hint")).toContainText(
    "Demucs needs WebGPU, which this browser does not offer",
  );
  await expect(plain.locator('[data-action="separate"]')).toBeDisabled();
  await plain.locator('[data-action="model"][data-model="spleeter-5"]').click();
  await expect(plain.locator('[data-action="separate"]')).toBeEnabled();
});
