import { analyzeRhythm } from "./analysis/rhythm";
import { analyzeTonal } from "./analysis/tonal";
import type { AnalysisRequest, AnalysisResponse } from "./messages";

/**
 * Rhythm, then key and chord analysis off the page's thread. One request per
 * worker: the page terminates the worker to cancel.
 */

/** Share of the progress taken by the rhythm. */
const RHYTHM_SHARE = 0.4;

self.addEventListener("message", (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  if (request.type !== "analyze") return;
  const { id } = request;
  const report = (stage: string, progress: number) =>
    self.postMessage({ type: "progress", id, stage, progress } satisfies AnalysisResponse);
  try {
    const rhythm = analyzeRhythm(
      { source: request.source, sourceName: request.sourceName, bass: request.bass },
      (stage, progress) => report(stage, progress * (request.harmonic ? RHYTHM_SHARE : 1)),
    );
    const tonal = request.harmonic
      ? analyzeTonal(
        {
          harmonic: request.harmonic,
          bass: request.bass,
          beats: rhythm.beats,
          beatsPerBar: rhythm.beatsPerBar,
        },
        (stage, progress) => report(stage, RHYTHM_SHARE + progress * (1 - RHYTHM_SHARE)),
      )
      : {};
    self.postMessage(
      { type: "complete", id, result: { ...rhythm, ...tonal } } satisfies AnalysisResponse,
      { transfer: [rhythm.beats.buffer] },
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    } satisfies AnalysisResponse);
  }
});
