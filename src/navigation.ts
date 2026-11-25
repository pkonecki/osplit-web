/**
 * Back and forward between the app's pages (the library, settings, a
 * project), through the browser's history: each page shown gets an entry, so
 * the Back button or gesture returns to the page before instead of leaving
 * the app. The address doesn't change; entries carry the page in their state.
 */

/** A page: "library", "settings" or "project:<id>". */
export type Place = string;

interface Entry {
  osplit: number;
  place: Place;
}

/** The pages of this tab's entries, as far as the app knows them, and the current one. */
let places: Place[] = [];
let index = -1;
/** Pops caused by the app itself (going back to an entry it knows), to ignore. */
let ownPops = 0;
/** The page shown, which history catches up with once the app's own pops are done. */
let wanted: Place = "library";
/**
 * Shows a page the user went back or forward to; resolves false to stay
 * (Back closed something instead, or leaving isn't allowed now).
 */
let show: (place: Place, from: Place) => Promise<boolean> = async () => true;

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null &&
    typeof (value as Entry).osplit === "number" && typeof (value as Entry).place === "string";
}

/** Starts following Back and Forward; `onShow` shows the page navigated to. */
export function installNavigation(onShow: (place: Place, from: Place) => Promise<boolean>): void {
  show = onShow;
  window.addEventListener("popstate", (event) => {
    if (ownPops > 0) {
      ownPops--;
      settle();
      return;
    }
    // An entry without the app's state is the first one: the library.
    const entry = isEntry(event.state) ? event.state : { osplit: 0, place: "library" };
    const from = places[index] ?? "library";
    const target = entry.osplit;
    const previous = index;
    places[target] = entry.place;
    index = target;
    void show(entry.place, from).then((go) => {
      if (go) return;
      // Stay: step back to the entry that was current.
      index = previous;
      ownPops++;
      history.go(previous - target);
    }).catch(console.warn);
  });
}

/**
 * Records the page now shown (called after each render). A new page gets an
 * entry; going back to the page before reuses that entry, so leaving a
 * project for the library and pressing Back doesn't reopen it.
 */
export function placeShown(place: Place): void {
  if (index < 0) {
    // First page: the library underneath, so Back from a project restored at
    // start goes to the library rather than out of the app.
    places = ["library"];
    index = 0;
    history.replaceState({ osplit: 0, place: "library" } satisfies Entry, "");
  }
  wanted = place;
  settle();
}

/** Brings history to the page shown, unless one of the app's own pops is on its way. */
function settle(): void {
  if (ownPops > 0 || places[index] === wanted) return;
  if (index > 0 && places[index - 1] === wanted) {
    index--;
    ownPops++;
    history.back();
    return;
  }
  places = places.slice(0, index + 1);
  places.push(wanted);
  index++;
  history.pushState({ osplit: index, place: wanted } satisfies Entry, "");
}
