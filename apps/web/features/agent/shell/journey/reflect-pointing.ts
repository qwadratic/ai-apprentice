// Reflect: Clipa next to the selected item. A click on an item of the Work Map (a board card, a step, a gap, the teach-back)
// marks it with data-clipa-selected and asks Clipa to point at it ({surface: 'ui', hint: 'selected'}, resolved by
// clipa/targets.ts). Clicks into fields never move her: she never covers what the person types in.
import type { ClipaTarget } from '../../clipa/src/index.ts';

export const SELECTED_ATTR = 'data-clipa-selected';
export const SELECTED_TARGET: ClipaTarget = { surface: 'ui', hint: 'selected' };

/** What counts as an item of the map: the board's cards (WorkMapBoard), and the review view's steps, gaps and teach-back. */
export const ITEM_SELECTOR = '[data-card], .as-step, .as-gap, .as-teachback';
/** Clicks here are typing, not selecting. */
export const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
/** Where Reflect's items live: the mode panel while the canvas shows Reflect. */
export const REFLECT_SCOPE = '.as-main[data-mode="review"] .as-mode';

interface ItemElement {
  closest(selector: string): ItemElement | null;
}

/** The map item a click selects, or null (outside Reflect, in a field, or not on an item). Pure over `closest`. */
export function selectedItem<T extends ItemElement>(clicked: T | null): T | null {
  if (clicked === null || clicked.closest(FIELD_SELECTOR) !== null) return null;
  if (clicked.closest(REFLECT_SCOPE) === null) return null;
  return clicked.closest(ITEM_SELECTOR) as T | null;
}

/**
 * Listens for clicks under `root`; a click on a map item in Reflect moves the selection mark to it and calls `point`.
 * Returns the function that stops listening.
 */
export function watchReflectSelection(root: HTMLElement, point: (target: ClipaTarget) => void): () => void {
  let marked: Element | null = null;
  const onClick = (event: MouseEvent): void => {
    const clicked = event.target instanceof Element ? event.target : null;
    const item = selectedItem(clicked);
    if (item === null) return;
    if (marked !== null && marked !== item) marked.removeAttribute(SELECTED_ATTR);
    item.setAttribute(SELECTED_ATTR, '');
    marked = item;
    point(SELECTED_TARGET);
  };
  root.addEventListener('click', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    marked?.removeAttribute(SELECTED_ATTR);
  };
}
