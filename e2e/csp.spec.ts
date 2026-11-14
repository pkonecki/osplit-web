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
  await expect(page.locator(".waveform.drawn")).toHaveCount(5);
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
  await page.fill("#new-project-name", "URL");
  await page.click('[data-action="create"]');
  // Any URL starts the runtime; this one is not a media page, so the
  // download itself ends with an error message.
  await page.fill("#media-url", new URL("manifest.webmanifest", page.url()).href);
  await page.click('[data-action="download-url"]');
  await pyodide;
  await expect(page.locator('[data-action="download-url"]')).toBeEnabled({
    timeout: 180_000,
  });
  expect(await violations()).toEqual([]);
});
