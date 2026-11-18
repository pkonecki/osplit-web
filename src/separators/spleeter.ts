import * as ort from "onnxruntime-web";
import {
  CHANNELS,
  FREQUENCY_BINS,
  SAMPLES_PER_SEGMENT,
  SEGMENT_FRAMES,
} from "../audio-core";
import { loadModel, modelFiles } from "../models";
import {
  modelDownloadProgress,
  modelLoadedProgress,
  separationProgress,
} from "../progress";
import {
  logitsToMasks,
  OverlapAddSynthesizer,
  planStft,
  SegmentAnalyzer,
  segmentFrames,
} from "../stft";
import { MODEL_STEMS, type Quality } from "../types";
import {
  createSession,
  type Provider,
  releaseSessions,
  type Separator,
  type SeparatorContext,
  yieldToEventLoop,
} from "./separator";

/** Spleeter: five models, one per stem, masks over a magnitude spectrogram. */
export class SpleeterSeparator implements Separator {
  readonly stems = MODEL_STEMS["spleeter-5"];
  private sessions: ort.InferenceSession[] = [];
  private readonly quality: Quality;
  private readonly context: SeparatorContext;

  constructor(quality: Quality, context: SeparatorContext) {
    this.quality = quality;
    this.context = context;
  }

  async load(provider: Provider): Promise<void> {
    const { context } = this;
    const files = modelFiles("spleeter-5", this.quality);
    try {
      for (let index = 0; index < files.length; index++) {
        context.checkCancelled();
        const file = files[index];
        const bytes = await loadModel(file, {
          onProgress: (fraction) =>
            context.reportDownload(
              file,
              modelDownloadProgress(index, files.length, fraction),
            ),
          checkCancelled: context.checkCancelled,
        });
        this.sessions.push(await createSession(bytes, provider));
        context.report("Loading models", modelLoadedProgress(index, files.length));
      }
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  async run(
    samples: Float32Array,
    onSamples: (source: number, pcm: Int16Array) => void,
  ): Promise<void> {
    const { context, sessions, stems } = this;
    if (sessions.length !== stems.length) throw new Error("The models are not loaded.");
    const plan = planStft(samples.length / CHANNELS);
    const synthesizer = new OverlapAddSynthesizer(plan, {
      sourceCount: stems.length,
      onSamples,
    });
    const analyzer = new SegmentAnalyzer(samples, plan);
    const logits = new Float32Array(stems.length * CHANNELS * SAMPLES_PER_SEGMENT);

    for (let segment = 0; segment < plan.segmentCount; segment++) {
      context.checkCancelled();
      analyzer.analyze(segment);
      for (let index = 0; index < stems.length; index++) {
        context.checkCancelled();
        const session = sessions[index];
        const tensor = new ort.Tensor("float32", analyzer.spectrogram, [
          CHANNELS,
          1,
          SEGMENT_FRAMES,
          FREQUENCY_BINS,
        ]);
        const result = await session.run({ [session.inputNames[0]]: tensor });
        const output = result[session.outputNames[0]];
        if (!output || !(output.data instanceof Float32Array)) {
          throw new Error(`Unexpected output tensor for the ${stems[index]} model.`);
        }
        logits.set(
          output.data.subarray(0, CHANNELS * SAMPLES_PER_SEGMENT),
          index * CHANNELS * SAMPLES_PER_SEGMENT,
        );
        tensor.dispose();
        for (const value of Object.values(result)) value.dispose();
      }
      logitsToMasks(logits, stems.length, segmentFrames(plan, segment));
      synthesizer.synthesize(segment, analyzer.spectra, logits);
      context.report(
        `Separating · ${this.quality.toUpperCase()}`,
        separationProgress(segment + 1, plan.segmentCount),
      );
      await yieldToEventLoop();
    }
  }

  async release(): Promise<void> {
    const sessions = this.sessions;
    this.sessions = [];
    await releaseSessions(sessions);
  }
}
