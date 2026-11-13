/**
 * Re-rendering replaces the page's HTML. These keep typed text, focus and the
 * cursor position across a re-render of the same view.
 */

/** Text inputs whose content survives a re-render of the same view. */
const PRESERVED_INPUTS = ["new-project-name", "media-url"];

export interface FormSnapshot {
  view: string;
  values: Map<string, string>;
  focusId: string | null;
  selection: [number | null, number | null] | null;
}

export function captureForm(
  root: HTMLElement,
  view: string | null,
): FormSnapshot | null {
  if (view === null) return null;
  const values = new Map<string, string>();
  for (const id of PRESERVED_INPUTS) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input?.value) values.set(id, input.value);
  }
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id && root.contains(active) ? active.id : null;
  let selection: FormSnapshot["selection"] = null;
  try {
    if (focusId && active) selection = [active.selectionStart, active.selectionEnd];
  } catch {
    // Some input types (e.g. range) have no text selection.
  }
  return { view, values, focusId, selection };
}

export function restoreForm(
  snapshot: FormSnapshot | null,
  view: string,
): void {
  if (!snapshot || snapshot.view !== view) return;
  for (const [id, value] of snapshot.values) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input && !input.value) input.value = value;
  }
  if (!snapshot.focusId) return;
  const focused = document.getElementById(snapshot.focusId) as
    | HTMLInputElement
    | null;
  if (!focused || focused.disabled) return;
  focused.focus();
  const [start, end] = snapshot.selection ?? [null, null];
  if (start !== null && end !== null) {
    try {
      focused.setSelectionRange(start, end);
    } catch {
      // Not a text input.
    }
  }
}
