import { defineConfig } from "@playwright/test";

// End-to-end tests against two production builds (see README "Testing"):
// - root: dist/ at "/", with the cross-origin isolation headers (like nginx);
// - pages: dist-pages/ at "/osplit-web/", without them (like GitHub Pages),
//   where the service worker has to add them.
export default defineConfig({
  testDir: "e2e",
  timeout: 4 * 60 * 1000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    trace: "off",
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"],
      // Lets the suite use a preinstalled Chromium (PLAYWRIGHT_CHROMIUM_PATH).
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    },
  },
  projects: [
    {
      name: "root",
      use: { baseURL: "http://localhost:4173/" },
    },
    {
      name: "pages",
      use: { baseURL: "http://localhost:4180/osplit-web/" },
    },
  ],
  webServer: [
    {
      command: "node e2e/server.mjs dist / 4173 --isolation-headers",
      url: "http://localhost:4173/",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node e2e/server.mjs dist-pages /osplit-web/ 4180",
      url: "http://localhost:4180/osplit-web/",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
