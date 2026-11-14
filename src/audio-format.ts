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

/**
 * Number of stereo frames in a stored stem, read from its header without
 * decoding: the total sample count in FLAC's STREAMINFO, or the size of a
 * WAV file's data chunk.
 */
export async function stemFrameCount(blob: Blob): Promise<number> {
  const header = new Uint8Array(await blob.slice(0, 44).arrayBuffer());
  const view = new DataView(header.buffer);
  const magic = String.fromCharCode(...header.subarray(0, 4));
  if (magic === "fLaC" && header.length >= 26 && (header[4] & 0x7f) === 0) {
    // STREAMINFO starts at byte 8; the 36-bit sample count spans bytes 21–25.
    return (header[21] & 0x0f) * 2 ** 32 + view.getUint32(22);
  }
  if (magic === "RIFF" && header.length >= 44) {
    return view.getUint32(40, true) / 4;
  }
  throw new Error("A project stem is in an unknown audio format.");
}
