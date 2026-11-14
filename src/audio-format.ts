/** Formats stems are stored and exported in. */
export type AudioFormat = "flac" | "wav";

export const AUDIO_MIME: Record<AudioFormat, string> = {
  flac: "audio/flac",
  wav: "audio/wav",
};

/**
 * The format of a stored stem. New separations store FLAC; projects separated
 * before that keep WAV stems. The MIME type is checked first, then the file's
 * first bytes ("fLaC" or "RIFF").
 */
export async function detectAudioFormat(blob: Blob): Promise<AudioFormat> {
  if (blob.type === AUDIO_MIME.flac) return "flac";
  if (blob.type === AUDIO_MIME.wav) return "wav";
  const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const text = String.fromCharCode(...magic);
  if (text === "fLaC") return "flac";
  if (text === "RIFF") return "wav";
  throw new Error("A project stem is in an unknown audio format.");
}

/** File extension for a blob's format, from its MIME type. */
export function audioExtension(blob: Blob): AudioFormat {
  return blob.type === AUDIO_MIME.flac ? "flac" : "wav";
}
