import { describe, expect, it } from "vitest";
import { stemsZipName } from "./export-names";

describe("export names", () => {
  it("names a zip of every stem after the project", () => {
    expect(stemsZipName("Song", ["vocals", "piano", "drums", "bass", "other"], 5)).toBe("Song-stems.zip");
    expect(stemsZipName("Song", ["vocals", "piano", "drums", "bass", "other", "click"], 5)).toBe("Song-stems.zip");
  });

  it("lists the stems of a subset", () => {
    expect(stemsZipName("Song", ["drums", "bass"], 5)).toBe("Song-drums-bass.zip");
    expect(stemsZipName("Song", ["vocals", "click"], 6)).toBe("Song-vocals-click.zip");
  });
});
