// Renders the PNG app icons from public/icon.svg into public/icons/.
// Run after changing the SVG:  node scripts/icons.mjs
// Uses Playwright's Chromium (a dev dependency of the browser tests).
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public/icon.svg"), "utf8");
const out = join(root, "public/icons");
mkdirSync(out, { recursive: true });

// size: output pixels; scale: share of the canvas the icon fills (maskable
// icons keep their content inside the central 80% "safe zone");
// background: fill behind the icon, or none.
const icons = [
  { file: "icon-192.png", size: 192, scale: 1, background: null },
  { file: "icon-512.png", size: 512, scale: 1, background: null },
  { file: "maskable-512.png", size: 512, scale: 0.8, background: "#252d23" },
  { file: "apple-touch-icon.png", size: 180, scale: 0.86, background: "#252d23" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const { file, size, scale, background } of icons) {
  const inner = Math.round(size * scale);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html>
    <style>
      html, body { margin: 0; width: ${size}px; height: ${size}px; background: ${background ?? "transparent"}; }
      body { display: grid; place-items: center; }
      svg { width: ${inner}px; height: ${inner}px; display: block; }
    </style>${svg.replace(/^<\?xml[^>]*>/, "")}`);
  await page.screenshot({
    path: join(out, file),
    omitBackground: background === null,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  console.log(`public/icons/${file}`);
}
await browser.close();
