import { escapeHtml } from "./format";

/**
 * Asks the user to confirm a destructive action in a modal <dialog>. Resolves
 * true only for the confirm button; Cancel, Esc and closing resolve false.
 * Cancel has the focus, so a stray Enter keeps the data.
 */
export function confirmDialog(
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-label", "Confirm");
  dialog.innerHTML = `
    <form method="dialog">
      <p>${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button class="button subtle" value="cancel" autofocus>Cancel</button>
        <button class="button danger" value="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </form>`;
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
      dialog.remove();
    }, { once: true });
    dialog.showModal();
  });
}

export interface DialogChoice {
  value: string;
  label: string;
}

/**
 * Asks the user to pick one of `choices` in a modal <dialog>. Resolves the
 * chosen value, or null for Cancel, Esc and closing. Cancel has the focus.
 */
export function choiceDialog(
  message: string,
  choices: DialogChoice[],
): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-label", "Choose");
  dialog.innerHTML = `
    <form method="dialog">
      <p>${escapeHtml(message)}</p>
      <div class="dialog-actions">
        <button class="button subtle" value="" autofocus>Cancel</button>
        ${
    choices.map((choice) =>
      `<button class="button secondary" value="${escapeHtml(choice.value)}">${
        escapeHtml(choice.label)
      }</button>`
    ).join("")
  }
      </div>
    </form>`;
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue;
      resolve(choices.some((choice) => choice.value === value) ? value : null);
      dialog.remove();
    }, { once: true });
    dialog.showModal();
  });
}
