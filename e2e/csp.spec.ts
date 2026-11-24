import { expect, test } from "@playwright/test";
import { openApp, separateClip, writeTestClip } from "./helpers";

// Runs against the Docker image (DOCKER_URL), which sends the
// Content-Security-Policy from deploy/security-headers.conf. Fails on any
// violation, so a policy too strict for the app shows up in CI.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  writeTestClip(clip);
});

declare global {
  interface Window {
    __violations: string[];
  }
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
});

/** Violations seen by the page, plus CSP errors reported by its workers. */
function watchViolations(page: import("@playwright/test").Page): () => Promise<string[]> {
  const fromConsole: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) fromConsole.push(message.text());
  });
  page.on("worker", (worker) =>
    worker.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) fromConsole.push(message.text());
    })
  );
  return async () => [
    ...await page.evaluate(() => window.__violations),
    ...fromConsole,
  ];
}

test("sends the security headers", async ({ page }) => {
  const response = await page.goto("./");
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
});

test("separates and plays a clip without CSP violations", async ({ page }) => {
  const violations = watchViolations(page);
  await openApp(page);
  await separateClip(page, "CSP", clip);
  await page.click('[data-action="play"]');
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Pause");
  // The rhythm analysis ran in its worker (this clip has no beat).
  await expect(page.locator("#tempo-chip")).toHaveText("No beat", { timeout: 60_000 });
  // A key shift loads the pitch shifter's module and its AudioWorklet.
  await page.locator('[data-action="panel"][data-panel="key"]').click();
  await page.click('[data-action="key-step"][data-step="1"]');
  await expect(page.locator("#key-value")).toHaveText("+1");
  await expect.poll(() =>
    page.evaluate(() =>
      performance.getEntriesByType("resource")
        .some((entry) => entry.name.includes("SignalsmithStretch"))
    )
  ).toBe(true);
  await page.waitForTimeout(1000);
  expect(await violations()).toEqual([]);
});

test("starts the URL downloader without CSP violations", async ({ page }) => {
  // Loads Pyodide and the FFmpeg core from jsDelivr; needs internet access.
  test.skip(!!process.env.NO_EXTERNAL_NETWORK, "No internet access here.");
  const violations = watchViolations(page);
  const pyodide = page.waitForResponse((response) =>
    response.url().startsWith("https://cdn.jsdelivr.net/pyodide/") && response.ok(), {
    timeout: 120_000,
  });
  await openApp(page);
  // Any URL starts the runtime; this one is not a media page, so the
  // download itself ends with an error message.
  await page.locator('[data-action="new-split"]:visible').first().click();
  const split = page.getByRole("dialog", { name: "New split" });
  await split.getByRole("button", { name: "Link" }).click();
  await split.getByLabel("Audio or video link").fill(new URL("manifest.webmanifest", page.url()).href);
  await split.getByLabel("Name").fill("URL");
  await split.getByRole("button", { name: /^Split into/ }).click();
  await pyodide;
  await expect(page.locator('[data-action="download-url"]')).toBeEnabled({
    timeout: 180_000,
  });
  expect(await violations()).toEqual([]);
});
