import type { PlayerTime } from "./engine";

/**
 * Lock-screen, notification and headphone controls through the Media Session
 * API. Does nothing in browsers without it.
 */

export interface MediaSessionControls {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  time(): PlayerTime;
}

const SKIP_SECONDS = 10;
let lastPositionUpdate = 0;
let lastPlaying = false;

function session(): MediaSession | null {
  return "mediaSession" in navigator ? navigator.mediaSession : null;
}

/** Shows the project as the playing media and routes the system controls. */
export function startMediaSession(
  title: string,
  controls: MediaSessionControls,
): void {
  const media = session();
  if (!media) return;
  media.metadata = new MediaMetadata({ title, artist: "OSplit stems" });
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => controls.play()],
    ["pause", () => controls.pause()],
    ["stop", () => {
      controls.pause();
      controls.seek(0);
    }],
    ["seekbackward", (details) =>
      controls.seek(
        controls.time().position - (details.seekOffset ?? SKIP_SECONDS),
      )],
    ["seekforward", (details) =>
      controls.seek(
        controls.time().position + (details.seekOffset ?? SKIP_SECONDS),
      )],
    ["seekto", (details) => {
      if (details.seekTime !== undefined) controls.seek(details.seekTime);
    }],
  ];
  for (const [action, handler] of handlers) {
    try {
      media.setActionHandler(action, handler);
    } catch {
      // This browser doesn't support the action.
    }
  }
  lastPositionUpdate = 0;
  updateMediaSession(controls.time(), true);
}

/**
 * Reports the playback state and position: at once when playback starts or
 * stops (or with `force`, after a seek), otherwise at most once a second.
 */
export function updateMediaSession(time: PlayerTime, force = false): void {
  const media = session();
  if (!media?.metadata) return;
  media.playbackState = time.playing ? "playing" : "paused";
  const changed = time.playing !== lastPlaying;
  lastPlaying = time.playing;
  const now = performance.now();
  if (!force && !changed && now - lastPositionUpdate < 1000) return;
  lastPositionUpdate = now;
  if (!time.duration) return;
  try {
    media.setPositionState({
      duration: time.duration,
      position: Math.min(time.position, time.duration),
      playbackRate: 1,
    });
  } catch {
    // An invalid state is ignored rather than breaking the player.
  }
}

/** Clears the controls when the player is released. */
export function stopMediaSession(): void {
  const media = session();
  if (!media) return;
  media.metadata = null;
  media.playbackState = "none";
  for (
    const action of [
      "play",
      "pause",
      "stop",
      "seekbackward",
      "seekforward",
      "seekto",
    ] as MediaSessionAction[]
  ) {
    try {
      media.setActionHandler(action, null);
    } catch {
      // Not supported.
    }
  }
}
