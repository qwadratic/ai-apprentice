// Where Clipa goes: a target is a {surface, hint} the brain names ("email", "send"); the page marks the elements with
// data-clipa-surface and data-clipa-hint. The lookup goes from the most specific element to the workspace box, so a surface the
// page does not mark still gets Clipa to the right area. Rectangles are viewport coordinates (getBoundingClientRect).
import type { ClipaTarget, RectLike } from '../../clipa/src/index.ts';

export const SURFACE_ATTR = 'data-clipa-surface';
export const HINT_ATTR = 'data-clipa-hint';

interface QueryRoot {
  querySelector(selector: string): Element | null;
}

const esc = (value: string): string => value.replace(/["\\]/g, '\\$&');

function visibleRect(el: Element | null): RectLike | null {
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/** The selectors to try for a target, most specific first. */
export function selectorsFor(target: ClipaTarget): string[] {
  const surface = esc(target.surface);
  const list: string[] = [];
  if (target.hint) list.push(`[${SURFACE_ATTR}="${surface}"][${HINT_ATTR}="${esc(target.hint)}"]`);
  list.push(`[${SURFACE_ATTR}="${surface}"]:not([${HINT_ATTR}])`);
  list.push(`[${SURFACE_ATTR}="workspace"]`);
  return list;
}

export function resolveClipaTarget(root: QueryRoot, target: ClipaTarget): RectLike | null {
  for (const selector of selectorsFor(target)) {
    const rect = visibleRect(root.querySelector(selector));
    if (rect !== null) return rect;
  }
  return null;
}
