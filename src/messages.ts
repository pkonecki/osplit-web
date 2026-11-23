import type { ModelId, Stem } from "./types";
import type { RhythmResult } from "./analysis/rhythm";
import type { TonalResult } from "./analysis/tonal";

/** Page → inference worker. */
export type InferenceRequest =
  | {
    type: "separate";
    id: string;
    model: ModelId;
    samples: Float32Array;
  }
  | { type: "cancel"; id: string };

/** Inference worker → page. */
export type InferenceResponse =
  | { type: "progress"; id: string; stage: string; progress: number }
  /** Where the separation runs; sent again if it moves to the CPU. */
  | { type: "provider"; id: string; provider: "webgpu" | "wasm" }
  | {
    type: "complete";
    id: string;
    /** The model's stems. */
    stems: Partial<Record<Stem, Blob>>;
    /** Waveform overview per stem (see src/peaks.ts). */
    peaks: Partial<Record<Stem, Float32Array>>;
  }
  | { type: "error"; id: string; message: string }
  | { type: "cancelled"; id: string };

/** Page → URL worker. */
export type UrlRequest =
  | { type: "download"; id: string; url: string }
  | { type: "update"; id: string; installedVersion: string | null };

/** URL worker → page. */
export type UrlResponse =
  | { type: "progress"; id: string; progress: number; stage: string }
  | { type: "downloaded"; id: string; name: string; blob: Blob }
  | { type: "updated"; id: string; version: string }
  | { type: "error"; id: string; message: string };

/** Page → analysis worker: mono signals at ANALYSIS_RATE (src/analysis/onset.ts). */
export type AnalysisRequest = {
  type: "analyze";
  id: string;
  source: Float32Array;
  sourceName: "drums" | "mix";
  bass?: Float32Array;
  /** Bass, piano, other and quieter vocals, for key and chords. */
  harmonic?: Float32Array;
};

/** Analysis worker → page. */
export type AnalysisResponse =
  | { type: "progress"; id: string; stage: string; progress: number }
  | { type: "complete"; id: string; result: RhythmResult & Partial<TonalResult> }
  | { type: "error"; id: string; message: string };
