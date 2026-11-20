import { describe, expect, it } from "vitest";
import { defaultModel, type GpuLike, modelAvailable, NO_GPU, probeGpu } from "./gpu";

function fakeGpu(adapter: { features: string[] } | null | "throws"): GpuLike {
  return {
    requestAdapter: () =>
      adapter === "throws"
        ? Promise.reject(new Error("GPU process crashed"))
        : Promise.resolve(
          adapter && { features: new Set(adapter.features) },
        ),
  };
}

describe("WebGPU detection", () => {
  it("reports the adapter and its shader-f16 feature", async () => {
    expect(await probeGpu(fakeGpu({ features: ["shader-f16"] }))).toEqual({
      webgpu: true,
      f16: true,
    });
    expect(await probeGpu(fakeGpu({ features: [] }))).toEqual({ webgpu: true, f16: false });
  });

  it("reports none without navigator.gpu, an adapter, or when it throws", async () => {
    expect(await probeGpu(undefined)).toEqual(NO_GPU);
    expect(await probeGpu(fakeGpu(null))).toEqual(NO_GPU);
    expect(await probeGpu(fakeGpu("throws"))).toEqual(NO_GPU);
  });
});

describe("model choice", () => {
  const full = { webgpu: true, f16: true };
  const noF16 = { webgpu: true, f16: false };

  it("offers Demucs with WebGPU, FP16 shaders or not (the model is FP32)", () => {
    expect(modelAvailable("htdemucs-6s", full)).toBe(true);
    expect(modelAvailable("htdemucs-6s", noF16)).toBe(true);
    expect(modelAvailable("htdemucs-6s", NO_GPU)).toBe(false);
    expect(modelAvailable("spleeter-5", NO_GPU)).toBe(true);
  });

  it("defaults to Demucs where it runs and Spleeter elsewhere", () => {
    expect(defaultModel(full)).toBe("htdemucs-6s");
    expect(defaultModel(noF16)).toBe("htdemucs-6s");
    expect(defaultModel(NO_GPU)).toBe("spleeter-5");
  });
});
