let wakeLock: WakeLockSentinel | null = null;
let wakeLockWanted = false;

/** Keeps the screen on during long tasks so the device does not sleep. */
export function acquireWakeLock(): void {
  wakeLockWanted = true;
  void requestWakeLock();
}

export function releaseWakeLock(): void {
  wakeLockWanted = false;
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
}

async function requestWakeLock(): Promise<void> {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") {
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (wakeLockWanted && !wakeLock) wakeLock = sentinel;
    else void sentinel.release();
  } catch {
    // Wake Lock can be refused (e.g. battery saver); processing continues.
  }
}

/** The browser drops the wake lock when the page is hidden; take it again on return. */
export function installWakeLock(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !wakeLockWanted) return;
    if (wakeLock?.released) wakeLock = null;
    if (!wakeLock) void requestWakeLock();
  });
}
