import { expect, type Page, test } from "@playwright/test";
import {
  createProjectWithClip,
  instrument,
  openApp,
  readStore,
  SEPARATION_TIMEOUT,
  writeTestClip,
} from "./helpers";

// Phone and desktop integration (M7): sharing to the app, drag and drop, the
// delete dialog, removing the source after separation, accessible progress
// and the install icons.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  writeTestClip(clip);
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(instrument);
});

/** Drops a small generated WAV (or another file) onto the app. */
async function dropFile(page: Page, name: string, type = "audio/wav"): Promise<void> {
  const transfer = await page.evaluateHandle(({ name, type }) => {
    const frames = 4410;
    const bytes = new DataView(new ArrayBuffer(44 + frames * 4));
    const text = (offset: number, value: string) =>
      [...value].forEach((char, i) => bytes.setUint8(offset + i, char.charCodeAt(0)));
    text(0, "RIFF");
    bytes.setUint32(4, 36 + frames * 4, true);
    text(8, "WAVEfmt ");
    bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true);
    bytes.setUint16(22, 2, true);
    bytes.setUint32(24, 44_100, true);
    bytes.setUint32(28, 44_100 * 4, true);
    bytes.setUint16(32, 4, true);
    bytes.setUint16(34, 16, true);
    text(36, "data");
    bytes.setUint32(40, frames * 4, true);
    const data = new DataTransfer();
    data.items.add(new File([bytes.buffer], name, { type }));
    return data;
  }, { name, type });
  await page.locator("#app").dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(page.locator("#app")).toHaveClass(/drop-target/);
  await page.locator("#app").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.locator("#app")).not.toHaveClass(/drop-target/);
}

test("asks before deleting a project, in an accessible dialog", async ({ page }) => {
  await openApp(page);
  await page.fill("#new-project-name", "Keep me?");
  await page.click('[data-action="create"]');
  await page.click('[data-action="home"] >> nth=1');
  const card = page.locator('[data-action="delete"]');
  const dialog = page.locator("dialog.confirm-dialog");

  await card.click();
  await expect(dialog).toBeVisible();
  // Cancel has the focus, so Enter keeps the project.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(card).toHaveCount(1);

  await card.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card).toHaveCount(1);

  await card.click();
  await dialog.getByRole("button", { name: "Delete project" }).click();
  await expect(card).toHaveCount(0);
  expect(await readStore(page, "projects")).toHaveLength(0);
});

test("drops audio to create a project or replace its source", async ({ page }) => {
  await openApp(page);
  // On the project list: a new project named after the file.
  await dropFile(page, "Dropped Song.wav");
  await expect(page.locator("h1")).toHaveText("Dropped Song");
  await expect(page.locator(".project-heading .muted")).toContainText("Dropped Song.wav");
  // On a project page: the file becomes its source.
  await dropFile(page, "Second take.wav");
  await expect(page.locator("h1")).toHaveText("Dropped Song");
  await expect(page.locator(".project-heading .muted")).toContainText("Second take.wav");
  expect(await readStore(page, "projects")).toHaveLength(1);
  // Anything else is refused with a message.
  await dropFile(page, "notes.txt", "text/plain");
  await expect(page.locator(".message span").first()).toContainText("doesn't look like audio");
});

test("opens a file shared to the installed app", async ({ page }) => {
  await openApp(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  // What the system share sheet does: a POST to the manifest's share_target.
  const status = await page.evaluate(async () => {
    const form = new FormData();
    form.append(
      "audio",
      new File([new Uint8Array(64)], "Shared Song.m4a", { type: "audio/mp4" }),
    );
    const response = await fetch("share", { method: "POST", body: form });
    return { redirected: response.redirected, url: response.url };
  });
  expect(status.redirected).toBe(true);
  expect(new URL(status.url).searchParams.get("shared")).toBe("1");
  await page.goto(status.url);
  await expect(page.locator("h1")).toHaveText("Shared Song");
  await expect(page.locator(".project-heading .muted")).toContainText("Shared Song.m4a");
  // The address no longer asks to import it again.
  expect(new URL(page.url()).searchParams.has("shared")).toBe(false);
  const [source] = await readStore<{ name: string; blob: Blob }>(page, "sources");
  expect(source.name).toBe("Shared Song.m4a");
  await page.reload();
  expect(await readStore(page, "projects")).toHaveLength(1);
});

test("removes the source after separation when asked; progress is accessible", async ({ page }) => {
  await openApp(page);
  await createProjectWithClip(page, "Space saver", clip);
  await page.check('[data-action="delete-source-option"]');
  await expect.poll(async () =>
    (await readStore<{ deleteSourceAfterSeparation?: boolean }>(page, "projects"))[0]
      .deleteSourceAfterSeparation
  ).toBe(true);
  await page.evaluate(() => {
    const values: string[] = [];
    (window as unknown as { __aria: string[] }).__aria = values;
    new MutationObserver(() => {
      const value = document.querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow");
      if (value && values.at(-1) !== value) values.push(value);
    }).observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  await expect(page.locator('[role="progressbar"]')).toHaveAttribute("aria-valuemin", "0");
  await page.click('[data-action="separate"]');
  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({
    timeout: SEPARATION_TIMEOUT,
  });

  const values = (await page.evaluate(() =>
    (window as unknown as { __aria: string[] }).__aria
  )).map(Number);
  expect(values.length).toBeGreaterThan(3);
  expect(values).toEqual([...values].sort((a, b) => a - b));

  await expect(page.locator(".source-removed")).toContainText("Import it again");
  await expect(page.locator('[data-action="separate"]')).toHaveCount(0);
  expect(await readStore(page, "sources")).toHaveLength(0);
  expect(await readStore(page, "stems")).toHaveLength(5);
  await page.click('[data-action="play"]');
  await expect(page.locator('[data-action="play"]')).toHaveAttribute("aria-label", "Pause");
});

test("declares install icons that exist at their sizes", async ({ page }) => {
  await openApp(page);
  const icons = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    const manifest = await (await fetch(link.href)).json() as {
      icons: { src: string; sizes: string; type: string; purpose: string }[];
      share_target: { action: string };
    };
    const apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')!;
    const entries = [
      ...manifest.icons.filter((icon) => icon.type === "image/png"),
      { src: apple.href, sizes: "180x180", type: "image/png", purpose: "apple" },
    ];
    return Promise.all(entries.map(async (icon) => {
      const bytes = new DataView(await (await fetch(new URL(icon.src, link.href))).arrayBuffer());
      return {
        purpose: icon.purpose,
        declared: icon.sizes,
        actual: `${bytes.getUint32(16)}x${bytes.getUint32(20)}`,
      };
    }));
  });
  expect(icons.map((icon) => icon.purpose).sort()).toEqual(["any", "any", "apple", "maskable"]);
  for (const icon of icons) expect(icon.actual).toBe(icon.declared);
});
