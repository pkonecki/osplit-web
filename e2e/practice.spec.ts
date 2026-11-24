import { expect, type Page, test } from "@playwright/test";
import {
  closePanel,
  instrument,
  openApp,
  openPanel,
  readStore,
  seekTo,
  separateClip,
  writeTestClip,
} from "./helpers";

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  // Long enough to hear a loop repeat and a slowed-down position.
  writeTestClip(clip, 6);
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(instrument);
});

interface SavedPractice {
  speed?: number;
  semitones?: number;
  loop?: { start: number; end: number; enabled: boolean };
}

async function saved(page: Page): Promise<SavedPractice> {
  const [project] = await readStore<SavedPractice>(page, "projects");
  return project;
}

const position = (page: Page) =>
  page.locator("#seek-bar").inputValue().then(Number);

/** Presses a shortcut with the focus on the page, not on a control. */
async function press(page: Page, key: string, times = 1): Promise<void> {
  if (await page.locator(".panel:visible").count()) await closePanel(page);
  await page.locator("h1").click();
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

test("speed, key and loop with decoded playback", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Practice", clip);
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Play");

  // Speed: buttons, presets, slider and ↑ / ↓; saved with the project.
  await openPanel(page, "speed");
  await page.click('[data-action="speed-step"][data-step="-1"]');
  await expect(page.locator("#speed-value")).toHaveText("95%");
  await expect(page.locator("#speed-chip-value")).toHaveText("95%");
  await page.locator("#speed").fill("70");
  await expect(page.locator("#speed-value")).toHaveText("70%");
  await page.click('[data-action="speed-preset"][data-speed="0.85"]');
  await expect(page.locator("#speed-value")).toHaveText("85%");
  await expect(page.locator('[data-action="speed-preset"][data-speed="0.85"]')).toHaveAttribute("aria-pressed", "true");
  await press(page, "ArrowDown", 8);
  await expect(page.locator("#speed-chip-value")).toHaveText("50%");
  await openPanel(page, "speed");
  await expect(page.locator('[data-action="speed-step"][data-step="-1"]')).toBeDisabled();
  await expect.poll(async () => (await saved(page)).speed).toBe(0.5);
  await closePanel(page);

  // Half speed: about 1 s of track per 2 s, through the pitch shifter, which
  // restores the pitch the slower sources lower.
  await page.click('[data-action="play"]');
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Pause");
  const startedAt = Date.now();
  const from = await position(page);
  await page.waitForTimeout(2000);
  const advanced = await position(page) - from;
  const elapsed = (Date.now() - startedAt) / 1000;
  expect(advanced).toBeGreaterThan(elapsed * 0.5 - 0.35);
  expect(advanced).toBeLessThan(elapsed * 0.5 + 0.35);
  let starts = await page.evaluate(() => window.__starts);
  expect(starts.map((start) => start.rate)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("shifter");

  // Key: the steppers and the key grid, shown and saved.
  await openPanel(page, "key");
  await page.click('[data-action="key-step"][data-step="1"]');
  await page.click('[data-action="key-step"][data-step="1"]');
  await expect(page.locator("#key-value")).toHaveText("+2");
  await page.click('[data-action="key-step"][data-step="-1"]');
  await expect(page.locator("#key-value")).toHaveText("+1");
  await expect.poll(async () => (await saved(page)).semitones).toBe(1);
  await page.click('[data-action="key-set"][data-semitones="-3"]');
  await expect(page.locator("#key-value")).toHaveText("−3");
  await expect(page.locator('[data-action="key-set"][data-semitones="-3"]')).toHaveAttribute("aria-pressed", "true");

  // Resetting speed and key bypasses the shifter again, and speed changes
  // reach the playing sources at once.
  await page.click('[data-action="key-reset"]');
  await expect(page.locator("#key-value")).toHaveText("Original");
  await openPanel(page, "speed");
  await page.click('[data-action="speed-reset"]');
  await expect(page.locator("#speed-value")).toHaveText("100%");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("direct");
  await press(page, "ArrowUp");
  await expect(page.locator("#speed-chip-value")).toHaveText("105%");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("shifter");
  await press(page, "ArrowDown");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("direct");
  await page.click('[data-action="play"]'); // pause
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Play");

  // Loop: A at 1 s sets the start (not yet on), B at 2 s the end (on).
  await seekTo(page, 1);
  await openPanel(page, "loop");
  await page.click('[data-action="loop-set"][data-edge="start"]');
  await expect(page.locator("#loop-value")).toHaveText("0:01.0–0:06.0");
  await expect(page.locator('.player [data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "false");
  await seekTo(page, 2);
  await page.click('[data-action="loop-set"][data-edge="end"]');
  await expect(page.locator("#loop-value")).toHaveText("0:01.0–0:02.0");
  await expect(page.locator('.player [data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");
  expect((await saved(page)).loop).toEqual({ start: 1, end: 2, enabled: true });
  // Setting the end at the playhead puts it at the loop end: it plays from
  // the loop start.
  await expect.poll(() => position(page)).toBe(1);
  await expect(page.locator(".scrub-loop")).toBeVisible();
  // Without a beat grid there are no bar loops.
  await expect(page.locator('[data-action="loop-bars"][data-bars="4"]')).toBeDisabled();
  await closePanel(page);

  // Playing stays inside the loop, which the sources repeat natively.
  await page.evaluate(() => {
    window.__starts = [];
  });
  await page.click('[data-action="play"]');
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(200);
    seen.push(await position(page));
  }
  expect(Math.min(...seen)).toBeGreaterThanOrEqual(1);
  expect(Math.max(...seen)).toBeLessThanOrEqual(2);
  // It wrapped at least once in 2.4 s of a 1 s loop.
  expect(seen.some((value, i) => i > 0 && value < seen[i - 1])).toBe(true);
  starts = await page.evaluate(() => window.__starts);
  expect(starts).toHaveLength(5);
  for (const start of starts) {
    expect(start).toMatchObject({ loop: true, loopStart: 1, loopEnd: 2 });
  }

  // A seek after the loop lands on its start; before it is allowed.
  await seekTo(page, 4);
  expect(await position(page)).toBeLessThan(1.5);
  await page.click('[data-action="play"]'); // pause
  await seekTo(page, 0.5);
  await expect.poll(() => position(page)).toBe(0.5);

  // L turns the loop off and on; it stays on the seek bar, faint.
  await press(page, "l");
  await expect(page.locator('.player [data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".scrub-loop")).toHaveClass(/off/);
  await expect(page.locator("#loop-chip-value")).toContainText("off");
  await page.click('.player [data-action="loop-toggle"]');
  await expect(page.locator('.player [data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");

  // Without a grid, ← / → move 5 s and Home goes to the start.
  await seekTo(page, 0.5);
  await press(page, "ArrowRight");
  await expect.poll(() => position(page)).toBeLessThan(1.5);
  await press(page, "Home");
  await expect.poll(() => position(page)).toBe(0);

  // Everything survives a reload.
  await press(page, "ArrowDown", 4);
  await openPanel(page, "key");
  await page.click('[data-action="key-set"][data-semitones="-3"]');
  await expect.poll(async () => (await saved(page)).semitones).toBe(-3);
  expect((await saved(page)).speed).toBe(0.8);
  await page.reload();
  await expect(page.locator("#speed-chip-value")).toHaveText("80%");
  await openPanel(page, "key");
  await expect(page.locator("#key-value")).toHaveText("−3");
  await expect(page.locator('.player [data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");
  await closePanel(page);
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("shifter");
  await page.click('[data-action="play"]');

  // Clear removes the loop.
  await openPanel(page, "loop");
  await page.click('[data-action="loop-clear"]');
  await expect(page.locator("#loop-value")).toHaveText("Off");
  await expect(page.locator(".scrub-loop")).toBeHidden();
  expect((await saved(page)).loop).toBeUndefined();
  await closePanel(page);

  // Without a loop, the Loop button makes one: 4 s from the playhead (no
  // beat grid here), turned on.
  await seekTo(page, 1);
  await page.click('.player [data-action="loop-toggle"]');
  await expect(page.locator('.player [data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await saved(page)).loop).toEqual({ start: 1, end: 5, enabled: true });
});

test("speed and loop with streaming playback", async ({ page, context }) => {
  // Too little memory for decoded stems: <audio> elements play them.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { get: () => 0.001 });
  });
  await openApp(page);
  await separateClip(page, "Streaming practice", clip);
  await press(page, "ArrowDown", 5);
  await expect(page.locator("#speed-chip-value")).toHaveText("75%");
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__audios.filter((a) => a.src).length))
    .toBe(5);
  // The elements change speed themselves, keeping the pitch: no shifter.
  const elements = await page.evaluate(() =>
    window.__audios.map((audio) => [audio.playbackRate, audio.preservesPitch])
  );
  expect(elements).toEqual(Array(5).fill([0.75, true]));
  expect(await page.evaluate(() => window.__routes.at(-1))).not.toBe("shifter");
  // A key shift goes through the shifter.
  await openPanel(page, "key");
  await page.click('[data-action="key-step"][data-step="1"]');
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("shifter");
  await page.click('[data-action="key-step"][data-step="-1"]');
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("direct");

  // Loop 1–2 s: the elements jump back to the start each time.
  await openPanel(page, "loop");
  await seekTo(page, 1);
  await page.click('[data-action="loop-set"][data-edge="start"]');
  await seekTo(page, 2);
  await page.click('[data-action="loop-set"][data-edge="end"]');
  const seen: number[] = [];
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(200);
    seen.push(await page.evaluate(() => window.__audios[0].currentTime));
  }
  expect(Math.min(...seen)).toBeGreaterThanOrEqual(0.95);
  expect(Math.max(...seen)).toBeLessThanOrEqual(2.05);
  expect(seen.some((value, i) => i > 0 && value < seen[i - 1])).toBe(true);
});

/** Strength of `frequency` in mono 16-bit samples (Goertzel). */
function strength(samples: Int16Array, frequency: number, rate = 44_100): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / rate);
  let previous = 0;
  let beforePrevious = 0;
  for (const sample of samples) {
    const value = sample / 32768 + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = value;
  }
  return Math.sqrt(
    previous * previous + beforePrevious * beforePrevious -
      coefficient * previous * beforePrevious,
  ) / samples.length;
}

/** The left channel of a 16-bit stereo WAV export. */
function leftChannel(bytes: Buffer): Int16Array {
  const frames = bytes.readUInt32LE(40) / 4;
  const left = new Int16Array(frames);
  for (let i = 0; i < frames; i++) left[i] = bytes.readInt16LE(44 + i * 4);
  return left;
}

test("exports the mix with speed, key and loop applied", async ({ page }) => {
  const { readFileSync } = await import("node:fs");
  await openApp(page);
  await separateClip(page, "Export practice", clip);
  await openPanel(page, "export");
  await page.selectOption('[data-action="export-format"]', "wav");
  await expect(page.locator(".export-practice")).toBeHidden();
  await closePanel(page);

  // Half speed over a 1 s loop: 2 s of audio, still at the original pitch
  // (the clip's 220 Hz tone stays at 220 Hz rather than dropping to 110 Hz).
  await press(page, "ArrowDown", 10);
  await openPanel(page, "loop");
  await seekTo(page, 1);
  await page.click('[data-action="loop-set"][data-edge="start"]');
  await seekTo(page, 2);
  await page.click('[data-action="loop-set"][data-edge="end"]');
  await openPanel(page, "export");
  await expect(page.locator(".export-practice")).toBeVisible();
  await page.locator('[data-action="export-practice"]').check();
  let download = page.waitForEvent("download");
  await page.click('[data-action="export-mix"]');
  let file = await download;
  expect(file.suggestedFilename()).toBe("Export practice-mix-practice.wav");
  let left = leftChannel(readFileSync(await file.path()));
  expect(left.length / 44_100).toBeCloseTo(2, 1);
  const middle = left.subarray(11_025, left.length - 11_025);
  expect(strength(middle, 220)).toBeGreaterThan(5 * strength(middle, 110));

  // An octave up at full speed, without the loop: the whole 6 s clip at
  // 440 Hz.
  await openPanel(page, "speed");
  await page.click('[data-action="speed-reset"]');
  await openPanel(page, "key");
  for (let i = 0; i < 12; i++) await page.click('[data-action="key-step"][data-step="1"]');
  await expect(page.locator("#key-value")).toHaveText("+12");
  await press(page, "l");
  await openPanel(page, "export");
  download = page.waitForEvent("download");
  await page.click('[data-action="export-mix"]');
  file = await download;
  left = leftChannel(readFileSync(await file.path()));
  expect(left.length / 44_100).toBeCloseTo(6, 1);
  const body = left.subarray(44_100, left.length - 44_100);
  expect(strength(body, 440)).toBeGreaterThan(5 * strength(body, 220));

  // Unchecked, the export is the plain mix again.
  await page.locator('[data-action="export-practice"]').uncheck();
  download = page.waitForEvent("download");
  await page.click('[data-action="export-mix"]');
  file = await download;
  expect(file.suggestedFilename()).toBe("Export practice-mix.wav");
  left = leftChannel(readFileSync(await file.path()));
  const plain = left.subarray(44_100, left.length - 44_100);
  expect(strength(plain, 220)).toBeGreaterThan(5 * strength(plain, 440));
});
