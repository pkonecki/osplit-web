import { describe, expect, it } from "vitest";
import type { ChordSegment } from "../types";
import { chromagram, segmentBoundaries } from "./chroma";
import { degrees, progression, type Progression } from "./harmony.test-helpers";
import { estimateKey } from "./key";
import { ANALYSIS_RATE } from "./onset";
import { keyName } from "./spelling";
import { analyzeTonal } from "./tonal";
import { addSaw } from "./harmony.test-helpers";
import { estimateTuning } from "./tuning";

/** Share of the progression's time where the detected chord matches (root and quality). */
function accuracy(chords: ChordSegment[], truth: Progression["truth"]): number {
  let right = 0;
  let total = 0;
  const step = 0.05;
  for (const { start, end, chord } of truth) {
    for (let time = start + step / 2; time < end; time += step) {
      total++;
      const found = chords.find((c) => c.start <= time && time < c.end);
      if (found && found.root === chord.root && found.quality === chord.quality) right++;
    }
  }
  return right / total;
}

describe("tuning", () => {
  it("measures a detuning of +20 cents", () => {
    const signal = new Float32Array(10 * ANALYSIS_RATE);
    for (const midi of [57, 60, 64, 69, 72]) addSaw(signal, midi, 0, 10, 0.05, 20);
    expect(Math.abs(estimateTuning(signal) - 20)).toBeLessThanOrEqual(3);
  });

  it("measures A = 432 Hz as about −32 cents", () => {
    const signal = new Float32Array(10 * ANALYSIS_RATE);
    for (const midi of [55, 59, 62, 67]) addSaw(signal, midi, 0, 10, 0.05, -31.8);
    expect(Math.abs(estimateTuning(signal) + 31.8)).toBeLessThanOrEqual(3);
  });

  it("reads concert pitch as 0", () => {
    const signal = new Float32Array(5 * ANALYSIS_RATE);
    for (const midi of [60, 64, 67]) addSaw(signal, midi, 0, 5, 0.05);
    expect(Math.abs(estimateTuning(signal))).toBeLessThanOrEqual(3);
  });
});

describe("key", () => {
  const cases: [string, "major" | "minor", number, number[]][] = [
    ["C major", "major", 0, [1, 4, 5, 1]],
    ["F# major", "major", 6, [1, 4, 5, 1]],
    ["A minor", "minor", 9, [1, 4, 5, 1]],
    ["Eb minor", "minor", 3, [1, 4, 5, 1]],
    ["G major", "major", 7, [1, 6, 2, 5]],
    ["D minor", "minor", 2, [1, 6, 4, 5]],
  ];
  for (const [name, mode, tonic, steps] of cases) {
    it(`finds ${name} from a cadence`, () => {
      const signal = progression({ chords: degrees(mode, tonic, steps), seed: tonic + 1 });
      const result = analyzeTonal({ harmonic: signal.harmonic, bass: signal.bass, beats: signal.beats, beatsPerBar: 4 });
      expect(result.key).not.toBeNull();
      expect(keyName(result.key!)).toBe(name);
      expect(result.key!.confidence).toBeGreaterThan(0.25);
    });
  }

  it("is null for silence and unclear for noise", () => {
    expect(estimateKey(new Float64Array(12))).toBeNull();
    const flat = estimateKey(new Float64Array(12).fill(1));
    expect(flat!.confidence).toBeLessThan(0.25);
  });

  it("follows a detuned track", () => {
    const signal = progression({ chords: degrees("major", 0, [1, 4, 5, 1]), cents: 45 });
    const result = analyzeTonal({ harmonic: signal.harmonic, bass: signal.bass, beats: signal.beats, beatsPerBar: 4 });
    expect(result.tuningCents).toBeGreaterThan(38);
    expect(keyName(result.key!)).toBe("C major");
  });

  it("flags a modulation held for 16 bars", () => {
    const first = progression({ chords: degrees("major", 0, [1, 4, 5, 1]), repeats: 8, seed: 2 });
    const second = progression({ chords: degrees("major", 2, [1, 4, 5, 1]), repeats: 8, seed: 3 });
    const join = (a: Float32Array, b: Float32Array) => {
      const out = new Float32Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    };
    const offset = first.harmonic.length / ANALYSIS_RATE;
    const beats = [...first.beats, ...second.beats.map((beat) => beat + offset)];
    const result = analyzeTonal({
      harmonic: join(first.harmonic, second.harmonic),
      bass: join(first.bass, second.bass),
      beats,
      beatsPerBar: 4,
    });
    expect(result.modulations).toBeDefined();
    expect(result.modulations!.map(keyName)).toEqual(["C major", "D major"]);
    expect(Math.abs(result.modulations![1].start - offset)).toBeLessThan(12);
  });
});

describe("chords", () => {
  const cases: [string, Parameters<typeof progression>[0]][] = [
    ["I–V–vi–IV in G", { chords: degrees("major", 7, [1, 5, 6, 4]) }],
    ["ii–V–I in Bb", { chords: degrees("major", 10, [2, 5, 1, 1]) }],
    ["a minor blues", {
      chords: degrees("minor", 9, [1, 1, 1, 1, 4, 4, 1, 1, 5, 4, 1, 5]),
      beatsPerChord: 4,
      repeats: 1,
    }],
    ["two chords a bar", { chords: degrees("major", 0, [1, 6, 4, 5]), beatsPerChord: 2, repeats: 4 }],
    ["with a melody", { chords: degrees("major", 4, [1, 4, 6, 5]), melody: [4, 1, 6, 8] }],
  ];
  for (const [name, options] of cases) {
    it(`labels ${name}`, () => {
      const signal = progression({ bpm: 100, ...options });
      const result = analyzeTonal({ harmonic: signal.harmonic, bass: signal.bass, beats: signal.beats, beatsPerBar: 4 });
      expect(accuracy(result.chords, signal.truth)).toBeGreaterThanOrEqual(0.9);
      // No segment within the music is shorter than a beat.
      const beat = 60 / 100;
      const inner = result.chords.filter((c) => c.start >= signal.beats[0] && c.end <= signal.beats.at(-1)!);
      for (const chord of inner) expect(chord.end - chord.start).toBeGreaterThanOrEqual(beat - 0.01);
    });
  }

  it("works without a beat grid", () => {
    const signal = progression({ chords: degrees("major", 7, [1, 5, 6, 4]) });
    const result = analyzeTonal({ harmonic: signal.harmonic, bass: signal.bass, beats: [], beatsPerBar: 4 });
    expect(accuracy(result.chords, signal.truth)).toBeGreaterThanOrEqual(0.85);
  });

  it("finds C/E when the bass holds E", () => {
    const signal = progression({
      chords: [{ root: 0, quality: "maj", bass: 4 }, { root: 5, quality: "maj" }, { root: 7, quality: "maj" }],
    });
    const result = analyzeTonal({ harmonic: signal.harmonic, bass: signal.bass, beats: signal.beats, beatsPerBar: 4 });
    expect(accuracy(result.chords, signal.truth)).toBeGreaterThanOrEqual(0.9);
    const slash = result.chords.filter((c) => c.root === 0);
    expect(slash.length).toBeGreaterThan(0);
    for (const chord of slash) expect(chord.bass).toBe(4);
    for (const chord of result.chords.filter((c) => c.root !== 0)) expect(chord.bass).toBeUndefined();
  });

  it("reports no chord over silence", () => {
    const signal = progression({ chords: degrees("major", 0, [1, 5]), repeats: 1 });
    const harmonic = new Float32Array(signal.harmonic.length + 4 * ANALYSIS_RATE);
    harmonic.set(signal.harmonic);
    const result = analyzeTonal({ harmonic, beats: [], beatsPerBar: 4 });
    const last = result.chords.at(-1)!;
    expect(last.root).toBeNull();
    expect(last.end - last.start).toBeGreaterThan(3);
    expect(analyzeTonal({ harmonic: new Float32Array(ANALYSIS_RATE), beats: [], beatsPerBar: 4 }))
      .toEqual({ tuningCents: 0, key: null, chords: [] });
  });

  it("segments cover the track, beat by beat", () => {
    expect(segmentBoundaries([0.5, 1, 1.5, 2], 3)).toEqual([0, 0.5, 1, 1.5, 2, 3]);
    expect(segmentBoundaries([], 1.2)).toEqual([0, 0.5, 1, 1.2]);
    expect(segmentBoundaries([0.05, 1, 2, 3], 3.05)).toEqual([0, 1, 2, 3.05]);
    expect(chromagram(new Float32Array(2048)).frames).toBe(2);
  });
});
