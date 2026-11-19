import { describe, expect, it } from "vitest";
import {
  ALL_KEYS,
  chordName,
  diatonicChords,
  keyName,
  keyUsesFlats,
  pitchName,
  relativeKey,
  transposeKey,
} from "./spelling";

describe("spelling", () => {
  it("names every key with its own signature", () => {
    expect(ALL_KEYS.map(keyName)).toEqual([
      "C major", "C minor", "Db major", "C# minor", "D major", "D minor",
      "Eb major", "Eb minor", "E major", "E minor", "F major", "F minor",
      "F# major", "F# minor", "G major", "G minor", "Ab major", "G# minor",
      "A major", "A minor", "Bb major", "Bb minor", "B major", "B minor",
    ]);
  });

  it("spells notes from the key signature", () => {
    expect(pitchName(6, { tonic: 2, mode: "major" })).toBe("F#");
    expect(pitchName(6, { tonic: 1, mode: "major" })).toBe("Gb");
    expect(pitchName(10, { tonic: 5, mode: "major" })).toBe("Bb");
    expect(pitchName(10, null)).toBe("A#");
    expect(keyUsesFlats({ tonic: 0, mode: "major" })).toBe(false);
    expect(keyUsesFlats({ tonic: 2, mode: "minor" })).toBe(true);
  });

  it("names chords, transposed and re-spelled", () => {
    const key = { tonic: 9, mode: "minor" as const };
    expect(chordName({ root: 9, quality: "min" }, key)).toBe("Am");
    expect(chordName({ root: 0, quality: "maj", bass: 4 }, key)).toBe("C/E");
    expect(chordName({ root: null, quality: "maj" }, key)).toBe("N.C.");
    // A minor up 1: Bb minor, spelled with flats.
    const shifted = transposeKey(key, 1);
    expect(keyName(shifted)).toBe("Bb minor");
    expect(chordName({ root: 5, quality: "maj" }, shifted, 1)).toBe("Gb");
    expect(chordName({ root: 0, quality: "maj", bass: 4 }, shifted, 1)).toBe("Db/F");
    expect(keyName(transposeKey({ tonic: 0, mode: "major" }, -13))).toBe("B major");
  });

  it("knows relative keys and diatonic chords", () => {
    expect(keyName(relativeKey({ tonic: 0, mode: "major" }))).toBe("A minor");
    expect(keyName(relativeKey({ tonic: 4, mode: "minor" }))).toBe("G major");
    expect(diatonicChords({ tonic: 7, mode: "major" }).map((c) => chordName(c, { tonic: 7, mode: "major" })))
      .toEqual(["G", "Am", "Bm", "C", "D", "Em"]);
  });
});
