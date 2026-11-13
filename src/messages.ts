import type { Quality, Stem } from "./types";

/** Page → inference worker. */
export type InferenceRequest =
  | { type: "separate"; id: string; quality: Quality; samples: Float32Array }
  | { type: "cancel"; id: string };

/** Inference worker → page. */
export type InferenceResponse =
  | { type: "progress"; id: string; stage: string; progress: number }
  | { type: "complete"; id: string; stems: Record<Stem, Blob> }
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
