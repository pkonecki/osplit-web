import { describe, expect, it } from "vitest";
import { isAudioFile, projectNameFor } from "./import";

describe("importing files", () => {
  it("names a project after the file, without its extension", () => {
    expect(projectNameFor("Song Title.mp3")).toBe("Song Title");
    expect(projectNameFor("live.2024.flac")).toBe("live.2024");
    expect(projectNameFor("no-extension")).toBe("no-extension");
    expect(projectNameFor(".wav")).toBe("Untitled project");
    expect(projectNameFor("  ")).toBe("Untitled project");
  });

  it("accepts audio by type or by extension", () => {
    expect(isAudioFile({ name: "a.bin", type: "audio/mpeg" })).toBe(true);
    expect(isAudioFile({ name: "Track.M4A", type: "" })).toBe(true);
    expect(isAudioFile({ name: "voice.opus", type: "application/octet-stream" }))
      .toBe(true);
    expect(isAudioFile({ name: "photo.jpg", type: "image/jpeg" })).toBe(false);
    expect(isAudioFile({ name: "notes.txt", type: "" })).toBe(false);
  });
});
