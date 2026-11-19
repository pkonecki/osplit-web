import { expect, type Page, test } from "@playwright/test";
import {
  instrument,
  openApp,
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
  await page.locator("h1").click();
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

test("speed, key and loop with decoded playback", async ({ page }) => {
  await openApp(page);
  await separateClip(page, "Practice", clip);
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Play");
  await expect(page.locator(".practice-reset")).toBeHidden();

  // Speed: buttons, slider and shortcuts; saved with the project.
  await page.click('[data-action="speed-step"][data-step="-1"]');
  await expect(page.locator("#speed-value")).toHaveText("95%");
  await page.locator("#speed").fill("70");
  await expect(page.locator("#speed-value")).toHaveText("70%");
  await press(page, "-", 4);
  await expect(page.locator("#speed-value")).toHaveText("50%");
  await expect(page.locator('[data-action="speed-step"][data-step="-1"]')).toBeDisabled();
  await expect.poll(async () => (await saved(page)).speed).toBe(0.5);
  await expect(page.locator(".practice-reset")).toBeVisible();

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

  // Key: comma and period, shown and saved; up to ±12.
  await press(page, ".", 2);
  await expect(page.locator("#key-value")).toHaveText("+2");
  await page.click('[data-action="key-step"][data-step="-1"]');
  await expect(page.locator("#key-value")).toHaveText("+1");
  await expect.poll(async () => (await saved(page)).semitones).toBe(1);

  // 0 resets speed and key: the shifter is bypassed again, and speed
  // changes reach the playing sources at once.
  await press(page, "0");
  await expect(page.locator("#speed-value")).toHaveText("100%");
  await expect(page.locator("#key-value")).toHaveText("Original");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("direct");
  await press(page, "=");
  await expect(page.locator("#speed-value")).toHaveText("105%");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("shifter");
  await press(page, "-");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("direct");
  await page.click('[data-action="play"]'); // pause
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Play");

  // Loop: [ at 1 s sets the start (not yet on), ] at 2 s the end (on).
  await seekTo(page, 1);
  await press(page, "[");
  await expect(page.locator("#loop-value")).toHaveText("0:01.0–0:06.0");
  await expect(page.locator('[data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "false");
  await seekTo(page, 2);
  await press(page, "]");
  await expect(page.locator("#loop-value")).toHaveText("0:01.0–0:02.0");
  await expect(page.locator('[data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");
  expect((await saved(page)).loop).toEqual({ start: 1, end: 2, enabled: true });
  // Setting the end at the playhead puts it at the loop end: it plays from
  // the loop start.
  await expect.poll(() => position(page)).toBe(1);
  await expect(page.locator(".loop-band").first()).toBeVisible();

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

  // L turns the loop off and on; the markers stay.
  await press(page, "l");
  await expect(page.locator('[data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".loop-band").first()).toHaveClass(/off/);
  await page.click('[data-action="loop-toggle"]');
  await expect(page.locator('[data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");

  // A focused handle moves with the arrow keys (0.1 s; Shift: 1 s).
  await page.locator('[data-loop-handle="end"]').focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#loop-value")).toHaveText("0:01.0–0:02.1");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("#loop-value")).toHaveText("0:01.0–0:03.1");
  await expect(page.locator('[data-loop-handle="end"]')).toHaveAttribute("aria-valuetext", "0:03.1");

  // Dragging on the ruler at full zoom draws no loop and doesn't seek.
  const ruler = page.locator(".loop-ruler");
  await ruler.scrollIntoViewIfNeeded();
  const box = (await ruler.boundingBox())!;
  const y = box.y + box.height / 2;
  const drag = async (fromX: number, toX: number, atY = y) => {
    await page.mouse.move(fromX, atY);
    await page.mouse.down();
    await page.mouse.move((fromX + toX) / 2, atY, { steps: 4 });
    await page.mouse.move(toX, atY, { steps: 4 });
    await page.mouse.up();
  };
  const at = (seconds: number) => box.x + box.width * (seconds / 6);
  const writes = await page.evaluate(() => window.__projectWrites);
  await drag(at(4.2), at(5.4));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__projectWrites)).toBe(writes);
  expect(await position(page)).toBe(0.5);

  // Dragging a loop edge moves it (snapping needs a beat grid: none here).
  await drag(at(3.1), at(5));
  await expect.poll(async () => (await saved(page)).loop?.end).toBeCloseTo(5, 1);
  expect((await saved(page)).loop?.start).toBeCloseTo(1, 1);
  await drag(at(1), at(2));
  await expect.poll(async () => (await saved(page)).loop?.start).toBeCloseTo(2, 1);
  expect((await saved(page)).loop?.end).toBeCloseTo(5, 1);
  // The edges can be dragged on the waveforms too.
  const wave = page.locator('[data-waveform="drums"]');
  await wave.scrollIntoViewIfNeeded();
  const waveBox = (await wave.boundingBox())!;
  const onWave = (seconds: number) => waveBox.x + waveBox.width * (seconds / 6);
  await drag(onWave(5), onWave(4), waveBox.y + waveBox.height / 2);
  await expect.poll(async () => (await saved(page)).loop?.end).toBeCloseTo(4, 1);
  expect(await position(page)).toBe(0.5);

  // A click on a waveform still seeks.
  await page.mouse.click(waveBox.x + waveBox.width * 0.25, waveBox.y + waveBox.height / 2);
  await expect.poll(() => position(page)).toBeCloseTo(1.5, 1);

  // On the ruler, dragging inside the loop moves it, keeping its length;
  // a click inside it still seeks.
  await ruler.scrollIntoViewIfNeeded();
  const rulerBox = (await ruler.boundingBox())!;
  const onRuler = (seconds: number) => rulerBox.x + rulerBox.width * (seconds / 6);
  const rulerMid = rulerBox.y + rulerBox.height / 2;
  await drag(onRuler(3), onRuler(3.5), rulerMid);
  await expect.poll(async () => (await saved(page)).loop?.start).toBeCloseTo(2.5, 1);
  expect((await saved(page)).loop?.end).toBeCloseTo(4.5, 1);
  expect(await position(page)).toBeCloseTo(1.5, 1);
  await drag(onRuler(3.5), onRuler(3), rulerMid);
  await expect.poll(async () => (await saved(page)).loop?.start).toBeCloseTo(2, 1);
  expect((await saved(page)).loop?.end).toBeCloseTo(4, 1);
  await page.mouse.click(onRuler(3), rulerMid);
  await expect.poll(() => position(page)).toBeCloseTo(3, 1);
  // So does a click on a loop edge, which leaves the loop as it was.
  await page.mouse.click(onRuler(2), rulerMid);
  await expect.poll(() => position(page)).toBeCloseTo(2, 1);
  expect((await saved(page)).loop).toMatchObject({ start: 2, end: 4 });
  await seekTo(page, 1.5);

  // Zoom: the overview marks the part in view.
  const viewBox = page.locator(".overview-window");
  const windowShare = () =>
    viewBox.evaluate((element: HTMLElement) => ({
      left: parseFloat(element.style.left),
      width: parseFloat(element.style.width),
    }));
  expect((await windowShare()).width).toBeCloseTo(100, 0);
  await page.click('[data-action="zoom"][data-zoom="in"]');
  expect(await windowShare()).toEqual({ left: 25, width: 50 });
  // Dragging on the ruler outside the loop moves along (a quarter of the
  // ruler: 0.75 s). The view is 1.5–4.5 s and the loop 2–4 s.
  await ruler.scrollIntoViewIfNeeded();
  const rulerNow = (await ruler.boundingBox())!;
  const rulerY = rulerNow.y + rulerNow.height / 2;
  await drag(rulerNow.x + rulerNow.width * 0.95, rulerNow.x + rulerNow.width * 0.7, rulerY);
  await expect.poll(async () => (await windowShare()).left).toBeCloseTo(37.5, 0);
  expect((await windowShare()).width).toBeCloseTo(50, 0);
  expect((await saved(page)).loop).toMatchObject({ start: 2, end: 4 });
  expect(await position(page)).toBeCloseTo(1.5, 1);
  // Dragging the overview window moves it too.
  const overview = page.locator(".overview");
  await overview.scrollIntoViewIfNeeded();
  const overviewBox = (await overview.boundingBox())!;
  const oy = overviewBox.y + overviewBox.height / 2;
  await drag(overviewBox.x + overviewBox.width * 0.6, overviewBox.x + overviewBox.width * 0.4, oy);
  await expect.poll(async () => (await windowShare()).left).toBeCloseTo(17.5, 0);
  // A plain wheel zooms on the overview, not on the waveforms.
  await wave.scrollIntoViewIfNeeded();
  const waveNow = (await wave.boundingBox())!;
  await page.mouse.move(waveNow.x + waveNow.width / 2, waveNow.y + waveNow.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(100);
  expect((await windowShare()).width).toBeCloseTo(50, 0);
  await overview.scrollIntoViewIfNeeded();
  const overviewNow = (await overview.boundingBox())!;
  await page.mouse.move(overviewNow.x + overviewNow.width * 0.4, overviewNow.y + overviewNow.height / 2);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await windowShare()).width).toBeLessThan(40);
  // Zoom to the loop, then back to the whole track.
  await page.click('[data-action="zoom"][data-zoom="loop"]');
  // 2–4 s with a 10% margin each side: 1.8–4.2 s of 6 s.
  await expect.poll(async () => (await windowShare()).left).toBeCloseTo(30, 0);
  expect((await windowShare()).width).toBeCloseTo(40, 0);
  await page.click('[data-action="zoom"][data-zoom="fit"]');
  expect(await windowShare()).toEqual({ left: 0, width: 100 });

  // Everything survives a reload.
  await press(page, "-", 4);
  await press(page, ",", 3);
  await expect.poll(async () => (await saved(page)).semitones).toBe(-3);
  expect((await saved(page)).speed).toBe(0.8);
  await page.reload();
  await expect(page.locator("#speed-value")).toHaveText("80%");
  await expect(page.locator("#key-value")).toHaveText("−3");
  await expect(page.locator('[data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-loop-handle="start"]')).toBeVisible();
  await page.click('[data-action="play"]');
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("shifter");
  await page.click('[data-action="play"]');

  // Reset clears speed, key and loop.
  await page.click('[data-action="practice-reset"]');
  await expect(page.locator("#speed-value")).toHaveText("100%");
  await expect(page.locator("#loop-value")).toHaveText("Off");
  await expect(page.locator(".practice-reset")).toBeHidden();
  await expect(page.locator('[data-loop-handle="start"]')).toBeHidden();
  const reset = await saved(page);
  expect(reset.speed).toBe(1);
  expect(reset.semitones).toBe(0);
  expect(reset.loop).toBeUndefined();

  // Without a loop, the Loop button makes one: 4 s from the playhead (no
  // beat grid here), turned on.
  await seekTo(page, 1);
  await page.click('[data-action="loop-toggle"]');
  await expect(page.locator('[data-action="loop-toggle"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await saved(page)).loop).toEqual({ start: 1, end: 5, enabled: true });
  await expect(page.locator('[data-loop-handle="start"]')).toBeVisible();
});

test("speed and loop with streaming playback", async ({ page, context }) => {
  // Too little memory for decoded stems: <audio> elements play them.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "deviceMemory", { get: () => 0.001 });
  });
  await openApp(page);
  await separateClip(page, "Streaming practice", clip);
  await press(page, "-", 5);
  await expect(page.locator("#speed-value")).toHaveText("75%");
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
  await press(page, ".");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("shifter");
  await press(page, ",");
  await expect.poll(() => page.evaluate(() => window.__routes.at(-1))).toBe("direct");

  // Loop 1–2 s: the elements jump back to the start each time.
  await seekTo(page, 1);
  await press(page, "[");
  await seekTo(page, 2);
  await press(page, "]");
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
  await page.selectOption('[data-action="export-format"]', "wav");
  await expect(page.locator(".export-practice")).toBeHidden();

  // Half speed over a 1 s loop: 2 s of audio, still at the original pitch
  // (the clip's 220 Hz tone stays at 220 Hz rather than dropping to 110 Hz).
  await press(page, "-", 10);
  await seekTo(page, 1);
  await press(page, "[");
  await seekTo(page, 2);
  await press(page, "]");
  await expect(page.locator(".export-practice")).toBeVisible();
  await page.check('[data-action="export-practice"]');
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
  await press(page, "0");
  await press(page, ".", 12);
  await press(page, "l");
  download = page.waitForEvent("download");
  await page.click('[data-action="export-mix"]');
  file = await download;
  left = leftChannel(readFileSync(await file.path()));
  expect(left.length / 44_100).toBeCloseTo(6, 1);
  const body = left.subarray(44_100, left.length - 44_100);
  expect(strength(body, 440)).toBeGreaterThan(5 * strength(body, 220));

  // Unchecked, the export is the plain mix again.
  await page.uncheck('[data-action="export-practice"]');
  download = page.waitForEvent("download");
  await page.click('[data-action="export-mix"]');
  file = await download;
  expect(file.suggestedFilename()).toBe("Export practice-mix.wav");
  left = leftChannel(readFileSync(await file.path()));
  const plain = left.subarray(44_100, left.length - 44_100);
  expect(strength(plain, 220)).toBeGreaterThan(5 * strength(plain, 440));
});
