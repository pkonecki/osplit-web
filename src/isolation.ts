/**
 * Cross-origin isolation lets ONNX Runtime use several WebAssembly threads.
 * Hosts that cannot send the COOP/COEP headers (such as GitHub Pages) rely on
 * the service worker adding them, which only applies to pages it controls, so
 * a page loaded before the worker took control is reloaded once.
 */

const RELOAD_ATTEMPTED_KEY = "osplit-isolation-reload-attempted";

export interface IsolationState {
  /** `crossOriginIsolated` for the current page. */
  isolated: boolean;
  /** Whether a service worker controls the page. */
  controlled: boolean;
  /** Whether a task is running that a reload would interrupt. */
  busy: boolean;
  /** Whether a reload for isolation was already tried without success. */
  attempted: boolean;
}

export function shouldReloadForIsolation(state: IsolationState): boolean {
  return !state.isolated && state.controlled && !state.busy && !state.attempted;
}

function readAttempted(): boolean {
  try {
    return localStorage.getItem(RELOAD_ATTEMPTED_KEY) !== null;
  } catch {
    // Without storage the loop guard cannot work, so never reload.
    return true;
  }
}

/**
 * Reloads the page once when the service worker can make it cross-origin
 * isolated. A browser that ignores headers added by service workers is
 * reloaded at most once, ever: the attempt is remembered until isolation works.
 */
export function enableIsolationReload(isBusy: () => boolean): void {
  if (!("serviceWorker" in navigator)) return;
  if (globalThis.crossOriginIsolated) {
    try {
      localStorage.removeItem(RELOAD_ATTEMPTED_KEY);
    } catch {
      // Nothing to clear.
    }
    return;
  }
  const reloadIfUseful = () => {
    const state: IsolationState = {
      isolated: Boolean(globalThis.crossOriginIsolated),
      controlled: navigator.serviceWorker.controller !== null,
      busy: isBusy(),
      attempted: readAttempted(),
    };
    if (!shouldReloadForIsolation(state)) return;
    try {
      localStorage.setItem(RELOAD_ATTEMPTED_KEY, String(Date.now()));
    } catch {
      return;
    }
    location.reload();
  };
  reloadIfUseful();
  navigator.serviceWorker.addEventListener("controllerchange", reloadIfUseful);
}
