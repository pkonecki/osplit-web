import { describe, expect, it } from "vitest";
import {
  describeError,
  escapeHtml,
  formatBytes,
  formatTime,
  safeFileName,
  statusLabel,
} from "./format";

describe("formatting helpers", () => {
  it("formats times as m:ss or h:mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5.9)).toBe("0:05");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(3600 + 62)).toBe("1:01:02");
    expect(formatTime(-3)).toBe("0:00");
  });

  it("formats sizes in KB below 1 MB and MB above", () => {
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(98.4 * 1024 ** 2)).toBe("98.4 MB");
  });

  it("makes project names safe as file names", () => {
    expect(safeFileName('My: "song" / take 2?')).toBe("My_ _song_ _ take 2_");
    expect(safeFileName("   ")).toBe("osplit");
    expect(safeFileName("a".repeat(150))).toHaveLength(100);
  });

  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;",
    );
  });

  it("labels project statuses", () => {
    expect(statusLabel("interrupted")).toBe("Interrupted");
    expect(statusLabel("empty")).toBe("Empty project");
  });

  it("explains a full browser storage", () => {
    expect(describeError(new DOMException("full", "QuotaExceededError")))
      .toMatch(/storage is full/);
    expect(describeError(new Error("Specific problem"))).toBe("Specific problem");
    expect(describeError("not an error")).toBe("Something went wrong.");
  });
});
