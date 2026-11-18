import stretchUrl from "signalsmith-stretch?url";

/**
 * Pitch shifting with Signalsmith Stretch (MIT), a WebAssembly AudioWorklet,
 * used on live input: the stems' mix goes in, the same mix comes out shifted
 * by a number of semitones and delayed by `latency` seconds.
 *
 * The library file is published as a hashed asset and loaded from it twice:
 * as a module here, and as the worklet module. By default the library would
 * load the worklet from a blob: URL, which the Content-Security-Policy
 * forbids (worklets follow script-src), so `moduleUrl` points it at the same
 * file instead.
 */

export interface PitchShifter {
  readonly node: AudioNode;
  /** Delay the shifter adds, in seconds. */
  readonly latency: number;
  /** Resolves once the shifter has the new setting. */
  setSemitones(semitones: number): Promise<void>;
  release(): void;
}

interface StretchNode extends AudioWorkletNode {
  latency(): Promise<number>;
  schedule(change: { active?: boolean; semitones?: number }): Promise<unknown>;
}

type StretchFactory = ((
  context: BaseAudioContext,
  options?: AudioWorkletNodeOptions,
) => Promise<StretchNode>) & { moduleUrl?: string };

let factory: Promise<StretchFactory> | undefined;

function loadFactory(): Promise<StretchFactory> {
  factory ??= (async () => {
    const url = new URL(stretchUrl, location.href).href;
    const module = await import(/* @vite-ignore */ url) as {
      default: StretchFactory;
    };
    module.default.moduleUrl = url;
    return module.default;
  })();
  factory.catch(() => {
    factory = undefined;
  });
  return factory;
}

/** Creates a stereo pitch shifter in `context` (also an offline context). */
export async function createPitchShifter(
  context: BaseAudioContext,
): Promise<PitchShifter> {
  const create = await loadFactory();
  const node = await create(context, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const latency = await node.latency();
  await node.schedule({ active: true, semitones: 0 });
  return {
    node,
    latency,
    async setSemitones(semitones) {
      await node.schedule({ semitones });
    },
    release() {
      void node.schedule({ active: false });
      node.disconnect();
    },
  };
}

export const PITCH_SHIFT_UNAVAILABLE =
  "Key and speed changes need AudioWorklet and WebAssembly, which this browser blocked. Playback continues at the original speed and key.";
