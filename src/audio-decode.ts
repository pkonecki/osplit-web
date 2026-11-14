import {
  SAMPLE_RATE,
  type StereoChannels,
  wavToStereo,
} from "./audio-core";
import { detectAudioFormat } from "./audio-format";

/**
 * Decodes a stored stem (FLAC or WAV, 16-bit stereo 44.1 kHz) to channels.
 * WAV is read directly; FLAC is decoded by the browser in an offline context
 * at 44.1 kHz, so nothing is resampled.
 */
export async function decodeStem(blob: Blob): Promise<StereoChannels> {
  const format = await detectAudioFormat(blob);
  const bytes = await blob.arrayBuffer();
  if (format === "wav") return wavToStereo(bytes);
  const context = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const decoded = await context.decodeAudioData(bytes);
  if (decoded.sampleRate !== SAMPLE_RATE) {
    throw new Error("A project stem has an unexpected sample rate.");
  }
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  return { left, right };
}
