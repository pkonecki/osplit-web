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
