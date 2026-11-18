import { analyzeRhythm } from "./analysis/rhythm";
import type { AnalysisRequest, AnalysisResponse } from "./messages";

/**
 * Rhythm analysis off the page's thread. One request per worker: the page
 * terminates the worker to cancel.
 */
self.addEventListener("message", (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  if (request.type !== "analyze") return;
  const { id } = request;
  try {
    const result = analyzeRhythm(
      { source: request.source, sourceName: request.sourceName, bass: request.bass },
      (stage, progress) =>
        self.postMessage(
          { type: "progress", id, stage, progress } satisfies AnalysisResponse,
        ),
    );
    self.postMessage(
      { type: "complete", id, result } satisfies AnalysisResponse,
      { transfer: [result.beats.buffer] },
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    } satisfies AnalysisResponse);
  }
});
