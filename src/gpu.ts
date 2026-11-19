import type { ModelId } from "./types";

/** What this browser's WebGPU offers for separation. */
export interface GpuSupport {
  /** A WebGPU adapter exists. */
  webgpu: boolean;
  /**
   * It has `shader-f16` (FP16 shaders). Not needed by the FP32 Demucs model
   * shipped now; kept for an FP16 model later.
   */
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
  // The reason goes to the console: the page only says "not available".
  if (!gpu) {
    console.info(
      "WebGPU: navigator.gpu is missing (browser without WebGPU, WebGPU turned off, or not a secure context: use https or localhost).",
    );
    return NO_GPU;
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      console.info(
        "WebGPU: no adapter (GPU blocklisted, hardware acceleration off, or the GPU process crashed earlier; see chrome://gpu and restart the browser).",
      );
      return NO_GPU;
    }
    const support = { webgpu: true, f16: adapter.features.has("shader-f16") };
    console.info("WebGPU: adapter found.", support);
    return support;
  } catch (error) {
    console.info("WebGPU: requestAdapter failed.", error);
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

/** Whether a model can run with this support: Demucs needs WebGPU. */
export function modelAvailable(model: ModelId, support: GpuSupport): boolean {
  return model === "spleeter-5" || support.webgpu;
}

/** Demucs where it can run (better stems), Spleeter elsewhere. */
export function defaultModel(support: GpuSupport = knownGpu()): ModelId {
  return modelAvailable("htdemucs-6s", support) ? "htdemucs-6s" : "spleeter-5";
}
