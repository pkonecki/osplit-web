import { expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

/** Writes a deterministic stereo 16-bit 44.1 kHz WAV test clip. */
export function writeTestClip(file: string, seconds = 3): void {
  const rate = 44_100;
  const frames = rate * seconds;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const value = 0.3 * Math.sin(2 * Math.PI * 220 * t) +
      0.2 * Math.sin(2 * Math.PI * 60 * t) +
      0.1 * Math.sin(2 * Math.PI * 2500 * t);
    const sample = Math.round(value * 32767);
    buffer.writeInt16LE(sample, 44 + i * 4);
    buffer.writeInt16LE(sample, 46 + i * 4);
  }
  writeFileSync(file, buffer);
}

declare global {
  interface Window {
    __projectWrites: number;
    __gains: GainNode[];
    __audios: HTMLAudioElement[];
    __progress: { value: number; label: string }[];
  }
}

/** Init script: counts project writes and records audio nodes the app creates. */
export function instrument(): void {
  window.__projectWrites = 0;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "projects") window.__projectWrites++;
    return put.apply(this, args);
  };
  window.__gains = [];
  const createGain = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function () {
    const gain = createGain.call(this);
    window.__gains.push(gain);
    return gain;
  };
  window.__audios = [];
  const NativeAudio = window.Audio;
  window.Audio = function (src?: string) {
    const audio = new NativeAudio(src);
    window.__audios.push(audio);
    return audio;
  } as unknown as typeof Audio;
}

/**
 * Opens the app and waits until it is cross-origin isolated: at once behind a
 * server that sends the headers, after one reload where the service worker
 * adds them.
 */
export async function openApp(page: Page, path = "./"): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => crossOriginIsolated, null, {
    timeout: 20_000,
  });
  await expect(page.locator("h1")).toBeVisible();
}

export async function createProjectWithClip(
  page: Page,
  name: string,
  clip: string,
): Promise<void> {
  await page.fill("#new-project-name", name);
  await page.click('[data-action="create"]');
  const chooser = page.waitForEvent("filechooser");
  await page.click('[data-action="import"]');
  await (await chooser).setFiles(clip);
  await expect(page.locator('[data-action="separate"]')).toBeVisible();
}

/** Records every distinct progress value and label shown from now on. */
export async function recordProgress(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__progress = [];
    const record = () => {
      const value = document.querySelector(".progress-copy span:last-child")
        ?.textContent;
      const label =
        document.querySelector(".progress-copy span:first-child")
          ?.textContent ?? "";
      if (!value?.endsWith("%")) return;
      const number = Number(value.slice(0, -1));
      const last = window.__progress.at(-1);
      if (!last || last.value !== number || last.label !== label) {
        window.__progress.push({ value: number, label });
      }
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

/** Reads all keys, or all values, of an IndexedDB object store. */
export function readStore<T = unknown>(
  page: Page,
  store: string,
  what: "keys" | "values" = "values",
): Promise<T[]> {
  return page.evaluate(async ({ store, what }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("osplit-pwa");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const objectStore = db.transaction(store).objectStore(store);
    const request = what === "keys"
      ? objectStore.getAllKeys()
      : objectStore.getAll();
    const result = await new Promise<unknown[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  }, { store, what }) as Promise<T[]>;
}

export const SEPARATION_TIMEOUT = 3 * 60 * 1000;
