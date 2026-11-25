import { expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

/**
 * Writes a deterministic stereo 16-bit 44.1 kHz WAV test clip: steady tones (or,
 * with `chords`, a C–G–Am–F pad, a chord a bar),
 * plus with `bpm` a drum pattern at that tempo (a kick on every beat, louder
 * on each bar's first beat, and a noise burst on beats 2 and 4).
 */
export function writeTestClip(
  file: string,
  seconds = 3,
  bpm?: number,
  options: { chords?: boolean } = {},
): void {
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
  let noise = 12345;
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    let value = options.chords
      ? chordPad(t, 60 / (bpm ?? 120) * 4)
      : 0.3 * Math.sin(2 * Math.PI * 220 * t) +
        0.2 * Math.sin(2 * Math.PI * 60 * t) +
        0.1 * Math.sin(2 * Math.PI * 2500 * t);
    if (bpm) {
      const period = 60 / bpm;
      const beat = Math.floor(t / period);
      const since = t - beat * period;
      // Kick: a falling sine, louder on the bar's first beat.
      const kick = (beat % 4 === 0 ? 0.6 : 0.35) * Math.exp(-since / 0.05) *
        Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-since / 0.02)) * since);
      noise = (noise * 1664525 + 1013904223) >>> 0;
      const snare = beat % 2 === 1
        ? 0.3 * Math.exp(-since / 0.03) * (noise / 2 ** 32 - 0.5) * 2
        : 0;
      value = value * 0.5 + kick + snare;
    }
    const sample = Math.round(value * 32767);
    buffer.writeInt16LE(sample, 44 + i * 4);
    buffer.writeInt16LE(sample, 46 + i * 4);
  }
  writeFileSync(file, buffer);
}

/** C, G, Am, F (I–V–vi–IV in C): MIDI notes of each triad, and its bass note. */
const PAD_CHORDS = [
  { notes: [60, 64, 67], bass: 36 },
  { notes: [59, 62, 67], bass: 43 },
  { notes: [60, 64, 69], bass: 45 },
  { notes: [60, 65, 69], bass: 41 },
];

/** A pad playing PAD_CHORDS, a chord every `barSeconds`, with a bass note. */
function chordPad(t: number, barSeconds: number): number {
  const bar = Math.floor(t / barSeconds);
  const since = t - bar * barSeconds;
  const chord = PAD_CHORDS[bar % PAD_CHORDS.length];
  const envelope = Math.min(1, since / 0.02, (barSeconds - since) / 0.02);
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  let value = 0;
  for (const note of chord.notes) {
    for (let h = 1; h <= 4; h++) value += (0.08 / h) * Math.sin(2 * Math.PI * hz(note) * h * t);
  }
  value += 0.2 * Math.sin(2 * Math.PI * hz(chord.bass) * t) +
    0.06 * Math.sin(2 * Math.PI * hz(chord.bass) * 2 * t);
  return value * envelope;
}

declare global {
  interface Window {
    __projectWrites: number;
    __gains: GainNode[];
    __audios: HTMLAudioElement[];
    __progress: { value: number; label: string }[];
    __starts: {
      when: number;
      offset: number;
      rate: number;
      loop: boolean;
      loopStart: number;
      loopEnd: number;
    }[];
    /** Sources stopped before they began playing (when they were due, in audio-clock seconds). */
    __earlyStops: number[];
    /** Where the stems' bus was last connected: straight out or the shifter. */
    __routes: ("direct" | "shifter")[];
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
  window.__starts = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (
    when?: number,
    offset?: number,
    duration?: number,
  ) {
    window.__starts.push({
      when: when ?? 0,
      offset: offset ?? 0,
      rate: this.playbackRate.value,
      loop: this.loop,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });
    (this as AudioBufferSourceNode & { __when?: number }).__when = when ?? 0;
    return duration === undefined
      ? start.call(this, when, offset)
      : start.call(this, when, offset, duration);
  };
  window.__earlyStops = [];
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (when?: number) {
    const due = (this as AudioBufferSourceNode & { __when?: number }).__when;
    if (due !== undefined && this.context.currentTime < due) window.__earlyStops.push(due);
    return stop.call(this, when);
  };
  window.__routes = [];
  const connect = AudioNode.prototype.connect as (
    this: AudioNode,
    destination: AudioNode,
    ...rest: number[]
  ) => AudioNode;
  AudioNode.prototype.connect = function (
    this: AudioNode,
    destination: AudioNode,
    ...rest: number[]
  ) {
    // The bus is the only gain the app makes without createGain that
    // connects to the speakers or a worklet.
    if (
      this instanceof GainNode && !window.__gains.includes(this) &&
      (destination instanceof AudioWorkletNode ||
        destination instanceof AudioDestinationNode)
    ) {
      window.__routes.push(
        destination instanceof AudioWorkletNode ? "shifter" : "direct",
      );
    }
    return connect.call(this, destination, ...rest);
  } as typeof AudioNode.prototype.connect;
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

/**
 * Adds an empty project straight to storage (the UI only makes projects
 * with audio, from New split) and opens it.
 */
export async function addEmptyProject(
  page: Page,
  name: string,
  model: "spleeter-5" | "htdemucs-6s" = "spleeter-5",
): Promise<void> {
  await page.evaluate(async ({ name, model }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("osplit-pwa");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put({
        id: crypto.randomUUID(),
        name,
        createdAt: now,
        updatedAt: now,
        sourceName: null,
        status: "empty",
        taskProgress: 0,
        taskStage: "",
        model,
        completedStems: [],
        volumes: {},
        mutedStems: [],
        soloStems: [],
        errorMessage: null,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { name, model });
  // The app may still be stepping back in history (leaving a project does),
  // which aborts a reload started meanwhile: reload again then.
  await page.reload().catch(async () => {
    await page.waitForLoadState();
    await page.reload();
  });
  await page.waitForFunction(() => crossOriginIsolated);
  // The page may reopen the last project; go to the library first.
  const home = page.locator('[data-action="home"]:visible');
  if (await home.count()) await home.first().click();
  await page.locator(".project-row", { hasText: name }).locator('[data-action="open"]').first().click();
  await expect(page.locator("h1")).toHaveText(name);
}

/** An empty project with the clip as its audio, not separated yet. */
export async function createProjectWithClip(
  page: Page,
  name: string,
  clip: string,
  model?: "spleeter-5" | "htdemucs-6s",
): Promise<void> {
  await addEmptyProject(page, name, model);
  const chooser = page.waitForEvent("filechooser");
  await page.click('[data-action="import"]');
  await (await chooser).setFiles(clip);
  await expect(page.locator('[data-action="separate"]')).toBeVisible();
}

/**
 * Starts a split from the library with the New split dialog: the clip, a
 * name and optionally a model. The project page opens, separating.
 */
export async function startSplit(
  page: Page,
  name: string,
  clip: string,
  model?: "spleeter-5" | "htdemucs-6s",
): Promise<void> {
  await page.locator('[data-action="new-split"]:visible').first().click();
  const dialog = page.getByRole("dialog", { name: "New split" });
  await expect(dialog).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a file" }).click();
  await (await chooser).setFiles(clip);
  await dialog.getByLabel("Name").fill(name);
  if (model) await dialog.locator(`[data-model="${model}"]`).click();
  await dialog.getByRole("button", { name: /^Split into/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText(name);
}

/** Records every distinct progress value and label shown from now on. */
export async function recordProgress(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__progress = [];
    const record = () => {
      const value = document.querySelector("#progress-value")?.textContent;
      const label =
        document.querySelector("#progress-stage")?.textContent ?? "";
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

/** Splits the clip from the library and waits for the stems. */
export async function separateClip(
  page: Page,
  name: string,
  clip: string,
): Promise<void> {
  await startSplit(page, name, clip);
  await expect(page.locator('[data-action="play"]')).toBeVisible({
    timeout: SEPARATION_TIMEOUT,
  });
}

/** Moves the seek bar as a user would. */
export async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.locator("#seek-bar").evaluate((input: HTMLInputElement, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
}

/** Opens a practice panel (Speed, Key, Loop, Rhythm, Export) if it isn't open. */
export async function openPanel(
  page: Page,
  name: "speed" | "key" | "loop" | "rhythm" | "export",
): Promise<void> {
  const panel = page.locator(`#panel-${name}`);
  if (await panel.isVisible()) return;
  await page.locator(`[data-action="panel"][data-panel="${name}"]:visible`).first().click();
  await expect(panel).toBeVisible();
}

/** Closes the open practice panel. */
export async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator(".panel:visible")).toHaveCount(0);
}
