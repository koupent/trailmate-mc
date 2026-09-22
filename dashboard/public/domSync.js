/**
 * "Do not touch DOM that has not changed."
 *
 * Every panel on this page is redrawn by a poll or a click, and a redraw is
 * never free: replacing markup drops the text selection, the caret and the
 * scroll position of everything inside it. Guards against that kept being
 * written one element at a time, each knowing nothing of the others; this is
 * the one place they should have shared.
 *
 * A write goes through a guard that remembers what the node was last given, so
 * an unchanged panel is left alone.
 *
 * A caller that means to keep nodes alive across redraws — the item picker does,
 * because a ticked box must not move under the cursor — keeps its markup free of
 * the values that change: no `checked`, no `value`, no `disabled`. The markup
 * then describes only the structure, and the values are written into it
 * afterwards one property at a time with `syncProp`, which leaves alone whatever
 * already holds the right value.
 */

/**
 * What each node was last given. Markup and text are two ways to own the same
 * node, so which one wrote last is part of the record: an error message dropped
 * into a panel with `syncText` must not let the markup that was there before
 * count as still on screen.
 *
 * @type {WeakMap<object, { kind: string, value: string }>}
 */
const shown = new WeakMap();

function isShowing(el, kind, value) {
  const prev = shown.get(el);
  return prev !== undefined && prev.kind === kind && prev.value === value;
}

/**
 * Replace markup only when it differs from what the node was last given.
 *
 * @param {{ innerHTML: string }} el
 * @param {string} html
 * @returns {boolean} whether the node was written
 */
export function syncHtml(el, html) {
  if (!el) return false;
  if (isShowing(el, 'html', html)) return false;
  shown.set(el, { kind: 'html', value: html });
  el.innerHTML = html;
  return true;
}

/**
 * Replace text only when it differs from what the node was last given.
 *
 * @param {{ textContent: string }} el
 * @param {string} text
 * @returns {boolean} whether the node was written
 */
export function syncText(el, text) {
  if (!el) return false;
  if (isShowing(el, 'text', text)) return false;
  shown.set(el, { kind: 'text', value: text });
  el.textContent = text;
  return true;
}

/**
 * Replace text without moving the reader. A log tail is re-fetched on every
 * 再読込 and on every tab switch; where someone had scrolled to is theirs, not
 * the fetch's.
 *
 * @param {{ textContent: string, scrollTop: number }} el
 * @param {string} text
 * @returns {boolean} whether the node was written
 */
export function syncTextKeepingScroll(el, text) {
  if (!el) return false;
  const top = el.scrollTop;
  if (!syncText(el, text)) return false;
  el.scrollTop = top;
  return true;
}

/**
 * Write one property only when it differs from what the node already has.
 * Reading the live value is the point for form controls: `value` carries what
 * was typed, and assigning the same string still jumps the caret to the end.
 *
 * @param {Record<string, unknown>} el
 * @param {string} name
 * @param {unknown} value
 * @returns {boolean} whether the property was written
 */
export function syncProp(el, name, value) {
  if (!el || el[name] === value) return false;
  el[name] = value;
  return true;
}
