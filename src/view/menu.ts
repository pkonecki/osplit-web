import { escapeHtml } from "./format";

/**
 * A small menu: a popover under its button on desktop, an action sheet from
 * the bottom on a phone. Arrow keys move between the items, Esc or a click
 * outside closes it. Resolves the chosen item's value, or null.
 */

export interface MenuItem {
  value: string;
  label: string;
  /** A second line, e.g. what the action does. */
  sub?: string;
  danger?: boolean;
}

export function openMenu(anchor: HTMLElement, label: string, items: MenuItem[]): Promise<string | null> {
  document.querySelector(".menu-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "menu-layer";
  layer.innerHTML = `
    <button class="menu-backdrop" aria-label="Close menu" tabindex="-1"></button>
    <div class="menu" role="menu" aria-label="${escapeHtml(label)}">
      <p class="menu-title">${escapeHtml(label)}</p>
      ${
    items.map((item) =>
      `<button class="menu-item${item.danger ? " danger" : ""}" role="menuitem" data-value="${escapeHtml(item.value)}">
        <span>${escapeHtml(item.label)}</span>${item.sub ? `<small>${escapeHtml(item.sub)}</small>` : ""}
      </button>`
    ).join("")
  }
    </div>`;
  document.body.append(layer);
  const menu = layer.querySelector<HTMLElement>(".menu")!;
  // Under the button, kept on screen.
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, window.innerWidth - 16);
  menu.style.setProperty("--menu-top", `${Math.round(rect.bottom + 6)}px`);
  menu.style.setProperty("--menu-left", `${Math.round(Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)))}px`);
  menu.style.setProperty("--menu-width", `${width}px`);
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")];
  anchor.setAttribute("aria-expanded", "true");
  return new Promise((resolve) => {
    const close = (value: string | null) => {
      layer.remove();
      anchor.setAttribute("aria-expanded", "false");
      document.removeEventListener("keydown", onKey, true);
      if (anchor.isConnected) anchor.focus();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === "ArrowDown" ? 1 : -1;
        buttons[(index + step + buttons.length) % buttons.length].focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        buttons[event.key === "Home" ? 0 : buttons.length - 1].focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    layer.addEventListener("click", (event) => {
      event.stopPropagation();
      const item = (event.target as HTMLElement).closest<HTMLElement>(".menu-item");
      if (item) close(item.dataset.value ?? null);
      else if ((event.target as HTMLElement).closest(".menu-backdrop")) close(null);
    });
    buttons[0]?.focus();
  });
}
