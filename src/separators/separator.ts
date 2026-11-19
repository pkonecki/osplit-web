import * as ort from "onnxruntime-web";
import type { ModelFile } from "../models";
import type { Stem } from "../types";

export type Provider = "webgpu" | "wasm";

/** What a separator needs from the worker around it. */
export interface SeparatorContext {
  /** Progress of the whole task, 0–100, with a stage label. */
  report(stage: string, progress: number): void;
  /** Download progress of a model file. */
  reportDownload(file: ModelFile, progress: number): void;
  /** Throws an AbortError once the task is cancelled. */
  checkCancelled(): void;
}

/**
 * One separation model. The worker owns provider choice and fallback,
 * encoding and progress; a separator loads its sessions and turns samples
 * into stems.
 */
export interface Separator {
  /** The stems `run` produces, in its source order. */
  readonly stems: readonly Stem[];
  /** Downloads (or reads from cache) and creates the sessions. */
  load(provider: Provider): Promise<void>;
  /**
   * Separates interleaved stereo 44.1 kHz audio. Each stem's final samples
   * go to `onSamples` as interleaved 16-bit PCM, in order; the array is
   * reused, so consume it right away.
   */
  run(
    samples: Float32Array,
    onSamples: (source: number, pcm: Int16Array) => void,
  ): Promise<void>;
  /** Frees the sessions; never throws. */
  release(): Promise<void>;
}

export async function createSession(
  model: ArrayBuffer,
  provider: Provider,
): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(model, {
    executionProviders: [provider],
    graphOptimizationLevel: "all",
  });
}

export async function releaseSessions(
  sessions: Iterable<ort.InferenceSession | undefined>,
): Promise<void> {
  await Promise.all(
    [...sessions].map(async (session) => {
      try {
        await session?.release();
      } catch {
        // Session teardown must not replace the inference result.
      }
    }),
  );
}

/** Lets the worker handle messages (e.g. cancel) between segments. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
