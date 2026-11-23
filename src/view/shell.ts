import { appUrl } from "../paths";
import { state } from "../state";
import { urlTaskActive } from "../tasks/url-download";
import { icon } from "./icons";

/** The app's top-level pages. A project page is open when one is selected. */
export type Route = "library" | "project" | "settings";

export function currentRoute(): Route {
  if (state.selectedProject) return "project";
  return state.page === "settings" ? "settings" : "library";
}

/**
 * The frame around every page: on desktop (768 px and wider) a rail on the
 * left with Library, New split and Settings; on a phone each page has its
 * own header instead (see `mobileHeader`).
 */
export function shellMarkup(route: Route, content: string): string {
  // A link download needs its page; a split runs in the background.
  const leaving = urlTaskActive() ? 'aria-disabled="true"' : "";
  const item = (
    name: "library" | "settings",
    action: string,
    label: string,
    iconName: "library" | "settings",
  ) => {
    const current = route === name || (name === "library" && route === "project");
    return `<button class="rail-item${current ? " current" : ""}" data-action="${action}" ${
      current && route !== "project" ? 'aria-current="page"' : ""
    } ${leaving}>${icon(iconName)}<span>${label}</span></button>`;
  };
  return `
    <div class="shell">
      <nav class="rail" aria-label="Main">
        <span class="rail-logo" title="OSplit">${icon("logo", 22)}</span>
        ${item("library", "home", "Library", "library")}
        <button class="rail-item" data-action="new-split" ${state.working ? 'aria-disabled="true"' : ""}>${icon("plus")}<span>New split</span></button>
        <span class="rail-spacer"></span>
        ${item("settings", "settings", "Settings", "settings")}
      </nav>
      <div class="page">${content}</div>
    </div>
  `;
}

/**
 * A phone page's header: a back button to the library (except on the
 * library itself), the title, and optional actions on the right. On desktop
 * only the title shows, as the page heading.
 */
export function pageHeader(
  title: string,
  options: { back?: boolean; actions?: string; subtitle?: string } = {},
): string {
  return `
    <header class="page-header">
      ${
    options.back
      ? `<button class="icon-button mobile-only" data-action="home" aria-label="Back to library" ${
        urlTaskActive() ? "disabled" : ""
      }>${icon("back", 22)}</button>`
      : ""
  }
      <div class="page-title">
        <h1>${title}</h1>
        ${options.subtitle ? `<p class="page-subtitle">${options.subtitle}</p>` : ""}
      </div>
      ${options.actions ? `<div class="page-actions">${options.actions}</div>` : ""}
    </header>
  `;
}

export function footerMarkup(): string {
  return `<footer class="page-footer">OSplit Web · runs on this device · <a href="${
    appUrl("README-web.html")
  }">Browser limitations</a></footer>`;
}
