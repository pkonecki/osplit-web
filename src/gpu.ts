import type { ModelId } from "./types";

/** What this browser's WebGPU offers for separation. */
export interface GpuSupport {
  /** A WebGPU adapter exists. */
  webgpu: boolean;
  /** It has `shader-f16`, which the FP16 Demucs model needs. */
  f16: boolean;
}

export const NO_GPU: GpuSupport = { webgpu: false, f16: false };

interface GpuAdapterLike {
  features: { has(name: string): boolean };
}

export interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

/** Asks the browser for a WebGPU adapter; never throws. */
export async function probeGpu(
  gpu: GpuLike | undefined = (navigator as Navigator & { gpu?: GpuLike }).gpu,
): Promise<GpuSupport> {
  if (!gpu) return NO_GPU;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return NO_GPU;
    return { webgpu: true, f16: adapter.features.has("shader-f16") };
  } catch {
    return NO_GPU;
  }
}

let detected: GpuSupport | undefined;
let detection: Promise<GpuSupport> | undefined;

/** Detects once per page; later calls reuse the answer. */
export function detectGpu(): Promise<GpuSupport> {
  detection ??= probeGpu().then((support) => (detected = support));
  return detection;
}

/** The detected support, or none while detection is still running. */
export function knownGpu(): GpuSupport {
  return detected ?? NO_GPU;
}

/** For tests: set or forget the detected support. */
export function setGpuForTests(support: GpuSupport | undefined): void {
  detected = support;
  detection = support ? Promise.resolve(support) : undefined;
}

/** Whether a model can run with this support. */
export function modelAvailable(model: ModelId, support: GpuSupport): boolean {
  return model === "spleeter-5" || (support.webgpu && support.f16);
}

/** Demucs where it can run (better stems), Spleeter elsewhere. */
export function defaultModel(support: GpuSupport = knownGpu()): ModelId {
  return modelAvailable("htdemucs-6s", support) ? "htdemucs-6s" : "spleeter-5";
}
