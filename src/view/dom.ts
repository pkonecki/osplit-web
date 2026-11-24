/**
 * Replaces an element's contents only when the markup changed since it was
 * last set here. Compares with the markup given, not `innerHTML`: the browser
 * serializes some markup differently (SVG's self-closing tags), so comparing
 * with `innerHTML` would replace the contents on every update and swallow a
 * click whose press and release land on different, replaced, elements.
 */
const shown = new WeakMap<Element, string>();

export function setHtml(element: Element, html: string): void {
  if (shown.get(element) === html && element.childNodes.length) return;
  element.innerHTML = html;
  shown.set(element, html);
}
