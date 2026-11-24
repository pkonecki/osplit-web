import { expect, test } from "@playwright/test";
import { FakeDropbox } from "./fake-dropbox";
import { openApp, readStore, writeTestClip } from "./helpers";

// Cloud sync with a Dropbox app folder answered in memory (e2e/fake-dropbox.ts).
// The test builds offer Dropbox (VITE_DROPBOX_APP_KEY); a connection is put
// in place as if back from the sign-in page.

let clip: string;

test.beforeAll(({}, testInfo) => {
  clip = testInfo.outputPath("clip.wav");
  writeTestClip(clip);
});

test("uploads by hand, syncs only projects in both places, settles a conflict", async ({ page, context }) => {
  const dropbox = new FakeDropbox();
  await dropbox.install(context);
  await context.addInitScript((connection) => {
    if (!localStorage.getItem("osplit-cloud-connection")) {
      localStorage.setItem("osplit-cloud-connection", connection);
      localStorage.setItem("osplit-cloud-auto-sync", "off");
    }
  }, FakeDropbox.connection());
  await openApp(page);

  // Settings: the account, the quota after a sync, automatic sync.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Settings" }).click();
  const section = page.locator('section[aria-labelledby="settings-cloud"]');
  await expect(section).toContainText("Connected to Dropbox");
  await expect(section).toContainText("as Test Player");
  await section.getByRole("button", { name: "Sync now" }).click();
  await expect(section).toContainText("4.7 GB of 1.8 TB used", { timeout: 15_000 });
  await expect(section.getByRole("switch", { name: /Sync automatically/ })).not.toBeChecked();

  // A project split here, without "Add to the cloud when done", stays here:
  // syncing doesn't upload it.
  await page.locator('[data-action="new-split"]:visible').first().click();
  const split = page.getByRole("dialog", { name: "New split" });
  const chooser = page.waitForEvent("filechooser");
  await split.getByRole("button", { name: "Choose a file" }).click();
  await (await chooser).setFiles(clip);
  await split.getByLabel("Name").fill("Local song");
  await split.getByRole("switch", { name: /Add to the cloud when done/ }).uncheck();
  await split.getByRole("button", { name: /^Split into/ }).click();
  await expect(page.locator('[data-action="play"]')).toBeVisible({ timeout: 120_000 });
  await page.click('[data-action="home"]:visible');
  const row = page.locator(".project-row", { hasText: "Local song" });
  await expect(row.locator(".project-sync")).toContainText("This device only");
  await page.locator(".sync-line").getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator(".sync-line")).toContainText("Last synced");
  expect([...dropbox.files.keys()]).toEqual([]);

  // Upload by hand: now in both places.
  await row.getByRole("button", { name: "Upload Local song to the cloud" }).click();
  await expect(row.locator(".project-sync")).toContainText("In Dropbox and here", { timeout: 30_000 });
  const [project] = await readStore<{ id: string; updatedAt: number }>(page, "projects");
  expect(dropbox.manifest(project.id).project.name).toBe("Local song");

  // Changed here and on another device since: a conflict, left alone by sync.
  await row.getByRole("button", { name: "More actions for Local song" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.locator("#text-dialog-input").fill("My take");
  await page.keyboard.press("Enter");
  const manifest = dropbox.manifest(project.id);
  dropbox.setManifest(project.id, {
    ...manifest,
    project: { ...manifest.project, name: "Their take", updatedAt: Date.now() + 60_000 },
  });
  await page.locator(".sync-line").getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator(".sync-line")).toContainText("1 project needs you");
  const mine = page.locator(".project-row", { hasText: "My take" });
  await expect(mine.locator(".project-sync")).toContainText("Changed in two places");

  // Keep both: the other device's version comes down as a second project.
  await mine.getByRole("button", { name: "Resolve My take" }).click();
  const dialog = page.getByRole("dialog", { name: /changed in two places/ });
  await expect(dialog.getByRole("radio", { name: /Keep both/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.locator(".project-row", { hasText: "Their take (other device)" })).toBeVisible({ timeout: 30_000 });
  await expect(mine.locator(".project-sync")).toContainText("In Dropbox and here");
  expect(dropbox.manifest(project.id).project.name).toBe("My take");
  await expect(page.locator(".sync-line")).not.toContainText("needs you");

  // Remove from this device: it stays in the cloud, to download again.
  await mine.getByRole("button", { name: "More actions for My take" }).click();
  await page.getByRole("menuitem", { name: /^Remove from this device/ }).click();
  await page.locator("dialog.confirm-dialog").getByRole("button", { name: "Remove from this device" }).click();
  const away = page.locator(".project-row.kind-cloud", { hasText: "My take" });
  await expect(away).toContainText("In Dropbox only");
  await away.getByRole("button", { name: "Download My take to this device" }).click();
  await expect(page.locator(".project-row:not(.kind-cloud)", { hasText: "My take" }).locator(".project-sync"))
    .toContainText("In Dropbox and here", { timeout: 30_000 });
});

test("adds a new split to the cloud when it is done", async ({ page, context }) => {
  const dropbox = new FakeDropbox();
  await dropbox.install(context);
  await context.addInitScript((connection) => {
    localStorage.setItem("osplit-cloud-connection", connection);
  }, FakeDropbox.connection());
  await openApp(page);
  await page.locator('[data-action="new-split"]:visible').first().click();
  const dialog = page.getByRole("dialog", { name: "New split" });
  await expect(dialog.getByRole("switch", { name: /Add to the cloud when done/ })).toBeChecked();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a file" }).click();
  await (await chooser).setFiles(clip);
  await dialog.getByRole("button", { name: /^Split into/ }).click();
  await expect(page.locator(".message span")).toContainText('Uploaded "clip"', { timeout: 120_000 });
  const [project] = await readStore<{ id: string; cloudUploadPending?: boolean }>(page, "projects");
  expect(project.cloudUploadPending).toBeFalsy();
  expect(dropbox.manifest(project.id).project.name).toBe("clip");
});
