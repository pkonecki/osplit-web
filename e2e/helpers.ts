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
    return duration === undefined
      ? start.call(this, when, offset)
      : start.call(this, when, offset, duration);
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

/** Creates a project from the clip and separates it. */
export async function separateClip(
  page: Page,
  name: string,
  clip: string,
): Promise<void> {
  await createProjectWithClip(page, name, clip);
  await page.click('[data-action="separate"]');
  await expect(page.locator('[data-action="export-mix"]')).toBeVisible({
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
