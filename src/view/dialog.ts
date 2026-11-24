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

/**
 * Asks for a line of text in a modal <dialog> (renaming something).
 * Resolves the trimmed text, or null for Cancel, Esc or an empty field.
 */
export function textDialog(title: string, label: string, value: string, maxLength = 80): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `
    <form method="dialog">
      <h2 class="dialog-title">${escapeHtml(title)}</h2>
      <label class="field-label" for="text-dialog-input">${escapeHtml(label)}</label>
      <input id="text-dialog-input" class="text-input" type="text" maxlength="${maxLength}" autocomplete="off" />
      <div class="dialog-actions">
        <button type="button" class="button subtle" data-cancel>Cancel</button>
        <button class="button primary" value="save">Save</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const input = dialog.querySelector<HTMLInputElement>("input")!;
  input.value = value;
  dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close(""));
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const text = input.value.trim();
      resolve(dialog.returnValue === "save" && text ? text : null);
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    input.select();
  });
}
