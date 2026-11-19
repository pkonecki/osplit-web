import * as ort from "onnxruntime-web";
import { toPcm16 } from "../audio-core";
import {
  DEMUCS_BINS,
  DEMUCS_FRAMES,
  DEMUCS_SEGMENT,
  DEMUCS_SOURCES,
  separateDemucs,
} from "../demucs";
import { loadModel, modelFiles } from "../models";
import {
  modelDownloadProgress,
  modelLoadedProgress,
  separationProgress,
} from "../progress";
import {
  createSession,
  type Provider,
  releaseSessions,
  type Separator,
  type SeparatorContext,
  yieldToEventLoop,
} from "./separator";

/** Shown while Demucs runs, so a slow bar does not look stuck. */
export const DEMUCS_STAGE = "Separating with Demucs – this takes longer than Spleeter";

/**
 * Demucs v4, 6 stems, one FP32 model. Runs on WebGPU only: the worker never
 * falls back to WASM, where it would be slower than real time.
 */
export class DemucsSeparator implements Separator {
  readonly stems = DEMUCS_SOURCES;
  private session: ort.InferenceSession | undefined;
  private readonly context: SeparatorContext;

  constructor(context: SeparatorContext) {
    this.context = context;
  }

  async load(provider: Provider): Promise<void> {
    if (provider !== "webgpu") {
      throw new Error("Demucs needs WebGPU. Separate with Spleeter instead.");
    }
    const { context } = this;
    const [file] = modelFiles("htdemucs-6s", "fp32");
    context.checkCancelled();
    const bytes = await loadModel(file, {
      onProgress: (fraction) =>
        context.reportDownload(file, modelDownloadProgress(0, 1, fraction)),
      checkCancelled: context.checkCancelled,
    });
    this.session = await createSession(bytes, provider);
    context.report("Loading models", modelLoadedProgress(0, 1));
  }

  async run(
    samples: Float32Array,
    onSamples: (source: number, pcm: Int16Array) => void,
  ): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("The Demucs model is not loaded.");
    const { context } = this;
    let pcm = new Int16Array(0);
    await separateDemucs(
      samples,
      async (mix, spec) => {
        const inputs = {
          mix: new ort.Tensor("float32", mix, [1, 2, DEMUCS_SEGMENT]),
          spec: new ort.Tensor("float32", spec, [1, 4, DEMUCS_BINS, DEMUCS_FRAMES]),
        };
        const result = await session.run(inputs);
        const wave = result.wave?.data;
        const specs = result.specs?.data;
        if (!(wave instanceof Float32Array) || !(specs instanceof Float32Array)) {
          throw new Error("Unexpected output tensors from the Demucs model.");
        }
        // The outputs are not disposed: their arrays are used after this
        // returns (disposing a CPU tensor drops its data).
        for (const tensor of Object.values(inputs)) tensor.dispose();
        return { wave, specs };
      },
      {
        onSamples(source, interleaved) {
          if (pcm.length < interleaved.length) pcm = new Int16Array(interleaved.length);
          const view = pcm.subarray(0, interleaved.length);
          for (let i = 0; i < interleaved.length; i++) view[i] = toPcm16(interleaved[i]);
          onSamples(source, view);
        },
        async onSegment(done, total) {
          context.report(DEMUCS_STAGE, separationProgress(done, total));
          await yieldToEventLoop();
        },
        checkCancelled: context.checkCancelled,
      },
    );
  }

  async release(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await releaseSessions([session]);
  }
}
