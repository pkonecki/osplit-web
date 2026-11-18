import { describe, expect, it } from "vitest";
import { beatsTempo } from "./beats";
import { estimateMetre } from "./downbeats";
import { ANALYSIS_RATE, downmixForAnalysis, makeMagnitudeSpectrum, onsetEnvelopes, rms } from "./onset";
import { analyzeRhythm } from "./rhythm";
import { fMeasure, pattern } from "./synthetic.test-helpers";
import { estimateTempo } from "./tempo";

describe("tempo and beats on synthetic patterns", () => {
  for (const bpm of [90, 120, 128, 174]) {
    it(`finds ${bpm} BPM and its beats`, () => {
      const signal = pattern({ seconds: 30, bpm }, bpm);
      const result = analyzeRhythm({ source: signal.drums, sourceName: "drums", bass: signal.bass });
      expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(1);
      expect(fMeasure(result.beats, signal.beats)).toBeGreaterThanOrEqual(0.9);
      expect(result.bpmConfidence).toBeGreaterThan(0.3);
    });
  }

  it("follows a tempo that drifts from 120 to 126 BPM", () => {
    const signal = pattern({ seconds: 60, bpm: 120, endBpm: 126 }, 7);
    const result = analyzeRhythm({ source: signal.drums, sourceName: "drums" });
    expect(fMeasure(result.beats, signal.beats)).toBeGreaterThanOrEqual(0.95);
    expect(result.bpm).toBeGreaterThan(121);
    expect(result.bpm).toBeLessThan(125);
  });

  it("reports the other octave for a slow pattern with strong eighth notes", () => {
    const signal = pattern({ seconds: 30, bpm: 70, offbeat: 0.9 }, 3);
    const tempo = estimateTempo(onsetEnvelopes(signal.drums).full);
    const octaves = [tempo.bpm, tempo.alternative ?? 0].map(Math.round).sort((a, b) => a - b);
    expect(Math.abs(octaves[0] - 70)).toBeLessThanOrEqual(1);
    expect(Math.abs(octaves[1] - 140)).toBeLessThanOrEqual(2);
  });

  it("gives low confidence to noise", () => {
    let seed = 5;
    const noise = Float32Array.from({ length: 20 * ANALYSIS_RATE }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.3;
    });
    const result = analyzeRhythm({ source: noise, sourceName: "mix" });
    expect(result.bpmConfidence).toBeLessThan(0.1);
    // No pulse: no grid to mislead.
    expect(result.beats.length).toBe(0);
  });

  it("returns no beats for steady tones", () => {
    const tones = Float32Array.from({ length: 6 * ANALYSIS_RATE }, (_, i) =>
      0.3 * Math.sin((2 * Math.PI * 220 * i) / ANALYSIS_RATE) +
      0.1 * Math.sin((2 * Math.PI * 2500 * i) / ANALYSIS_RATE));
    expect(analyzeRhythm({ source: tones, sourceName: "mix" }).beats.length).toBe(0);
  });

  it("is confident about a short backbeat pattern", () => {
    const signal = pattern({ seconds: 8, bpm: 120, offbeat: 0 }, 9);
    const result = analyzeRhythm({ source: signal.drums, sourceName: "drums", bass: signal.bass });
    expect(result.bpmConfidence).toBeGreaterThan(0.5);
  });

  it("returns no beats for silence", () => {
    const result = analyzeRhythm({ source: new Float32Array(ANALYSIS_RATE * 5), sourceName: "mix" });
    expect(result.beats.length).toBe(0);
    expect(result.bpmConfidence).toBe(0);
  });
});

describe("metre and downbeats", () => {
  it("finds 4/4 and the first downbeat", () => {
    const signal = pattern({ seconds: 30, bpm: 120, beatsPerBar: 4, firstDownbeat: 2 }, 11);
    const result = analyzeRhythm({ source: signal.drums, sourceName: "drums", bass: signal.bass });
    expect(result.beatsPerBar).toBe(4);
    const first = result.beats[result.firstDownbeatIndex];
    // The detected beat nearest the first true downbeat (index 2, 1.5 s).
    const downbeats = signal.beats.filter((_, i) => i >= 2 && (i - 2) % 4 === 0);
    expect(downbeats.some((time) => Math.abs(time - first) < 0.07)).toBe(true);
  });

  it("finds 3/4", () => {
    const signal = pattern({ seconds: 30, bpm: 100, beatsPerBar: 3, firstDownbeat: 1 }, 13);
    const result = analyzeRhythm({ source: signal.drums, sourceName: "drums", bass: signal.bass });
    expect(result.beatsPerBar).toBe(3);
    const first = result.beats[result.firstDownbeatIndex];
    const downbeats = signal.beats.filter((_, i) => i >= 1 && (i - 1) % 3 === 0);
    expect(downbeats.some((time) => Math.abs(time - first) < 0.07)).toBe(true);
  });

  it("defaults to 4/4 on the first beat without a low end", () => {
    expect(estimateMetre([0, 0.5, 1, 1.5, 2], new Float32Array(400))).toEqual({
      beatsPerBar: 4,
      firstDownbeat: 0,
    });
  });
});

describe("helpers", () => {
  it("computes tempo from evenly spaced beats", () => {
    expect(beatsTempo([1, 1.5, 2, 2.5, 3])).toBeCloseTo(120, 6);
    expect(beatsTempo([1, 2])).toBeNull();
  });

  it("downmixes stereo to half-rate mono, keeping low frequencies", () => {
    const rate = ANALYSIS_RATE * 2;
    const left = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / rate));
    const right = Float32Array.from(left);
    const mono = downmixForAnalysis(left, right);
    expect(mono.length).toBe(ANALYSIS_RATE);
    expect(rms(mono)).toBeCloseTo(Math.SQRT1_2, 2);
    // Sums into an existing buffer.
    downmixForAnalysis(left, right, mono);
    expect(rms(mono)).toBeCloseTo(Math.SQRT2, 2);
  });

  it("filters out frequencies above the new Nyquist limit", () => {
    const rate = ANALYSIS_RATE * 2;
    const left = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 18_000 * i) / rate));
    const mono = downmixForAnalysis(left, left);
    expect(rms(mono)).toBeLessThan(0.05);
  });
});

describe("magnitude spectrum", () => {
  it("matches a direct DFT", () => {
    const size = 64;
    const input = Float64Array.from({ length: size }, (_, n) => Math.sin(n * 0.7) + 0.3 * Math.cos(n * 2.1) + (n % 5) * 0.1);
    const magnitudes = new Float64Array(size / 2 + 1);
    makeMagnitudeSpectrum(size)(input, magnitudes);
    for (let k = 0; k <= size / 2; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < size; n++) {
        re += input[n] * Math.cos((-2 * Math.PI * k * n) / size);
        im += input[n] * Math.sin((-2 * Math.PI * k * n) / size);
      }
      expect(magnitudes[k]).toBeCloseTo(Math.hypot(re, im), 9);
    }
  });
});
