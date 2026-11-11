import { describe, expect, it } from "vitest";
import {
  MODEL_PHASE_PERCENT,
  modelDownloadProgress,
  modelLoadedProgress,
  separationProgress,
} from "./progress";

function taskProgressSequence(modelCount: number, segments: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < modelCount; index++) {
    for (let step = 0; step <= 20; step++) {
      values.push(modelDownloadProgress(index, modelCount, step / 20));
    }
    values.push(modelLoadedProgress(index, modelCount));
  }
  for (let done = 1; done <= segments; done++) {
    values.push(separationProgress(done, segments));
  }
  return values;
}

describe("task progress", () => {
  it.each([1, 3, 5, 7])("never goes backwards with %i models", (models) => {
    const values = taskProgressSequence(models, 13);
    values.slice(1).forEach((value, index) => {
      expect(value).toBeGreaterThanOrEqual(values[index]);
    });
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(100);
  });

  it("ends the model phase exactly where separation starts", () => {
    expect(modelLoadedProgress(4, 5)).toBe(MODEL_PHASE_PERCENT);
    expect(separationProgress(0, 10)).toBe(MODEL_PHASE_PERCENT);
  });

  it("clamps out-of-range download fractions", () => {
    expect(modelDownloadProgress(0, 5, Number.NaN)).toBe(0);
    expect(modelDownloadProgress(0, 5, 3)).toBeLessThan(
      modelLoadedProgress(0, 5),
    );
  });
});
