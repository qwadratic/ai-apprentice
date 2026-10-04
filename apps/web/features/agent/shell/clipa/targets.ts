// Where Clipa goes. Two kinds of target:
//   - A workspace target is a {surface, hint} the brain names ("email", "send"); the page marks the elements with
//     data-clipa-surface and data-clipa-hint. The lookup goes from the most specific element to the workspace box, so a surface
//     the page does not mark still gets Clipa to the right area.
//   - A UI target names a control of the app by its data-clipa-target value: {surface: 'ui', hint: name} (the conductor's
//     `point {kind: 'ui', name}`), {surface: 'journey', hint: name} (the journey of PR #37), or {surface: name} for a name the
//     page marks. Names match with '_' and '-' alike ("board_gap" finds data-clipa-target="board-gap"); a few names have a
//     fallback selector for controls that do not carry the attribute yet. A UI target never falls back to the workspace.
// Rectangles are viewport coordinates (getBoundingClientRect).
import type { ClipaTarget, RectLike } from '../../clipa/src/index.ts';

export const SURFACE_ATTR = 'data-clipa-surface';
export const HINT_ATTR = 'data-clipa-hint';
export const TARGET_ATTR = 'data-clipa-target';

/** Surfaces whose hint is a data-clipa-target name. */
export const UI_SURFACES: readonly string[] = ['ui', 'journey'];

/**
 * Controls that may not carry data-clipa-target yet, by the conductor's UI names (doc-12: share, start, mode_tab, board_gap,
 * teachback, summary) and the rail's stage names.
 */
export const UI_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  start: ['.as-session .as-btn--primary'],
  // The rail marks the stage Clipa suggests with data-clipa-target="mode_tab"; with none suggested, the stage on screen.
  mode_tab: ['.as-stage[aria-selected="true"]'],
  teachback: ['.as-teachback'],
  summary: ['.as-mastery'],
  board_gap: ['.as-gap'],
  share: ['.as-screen'],
  // The map item the person clicked in Reflect (journey/reflect-pointing.ts).
  selected: ['[data-clipa-selected]'],
};

interface QueryRoot {
  querySelector(selector: string): Element | null;
}

const esc = (value: string): string => value.replace(/["\\]/g, '\\$&');

function visibleRect(el: Element | null): RectLike | null {
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/** The data-clipa-target name a target asks for, or null for a workspace target. */
export function uiTargetName(target: ClipaTarget): string | null {
  if (UI_SURFACES.includes(target.surface)) return target.hint ? target.hint : null;
  return null;
}

/** A name with '_' and '-' alike: the name itself first, then the other spellings. */
export function nameVariants(name: string): string[] {
  const out = [name, name.replace(/_/g, '-'), name.replace(/-/g, '_')];
  return out.filter((v, i) => out.indexOf(v) === i);
}

/** The selectors for a UI name, most specific first. */
export function uiSelectors(name: string): string[] {
  const list = nameVariants(name).map((v) => `[${TARGET_ATTR}="${esc(v)}"]`);
  const key = name.replace(/-/g, '_');
  for (const selector of UI_FALLBACKS[key] ?? []) list.push(selector);
  return list;
}

/** The selectors to try for a target, most specific first. */
export function selectorsFor(target: ClipaTarget): string[] {
  const ui = uiTargetName(target);
  if (ui !== null) return uiSelectors(ui);
  if (UI_SURFACES.includes(target.surface)) return [];
  const surface = esc(target.surface);
  const list: string[] = [];
  if (target.hint) list.push(`[${SURFACE_ATTR}="${surface}"][${HINT_ATTR}="${esc(target.hint)}"]`);
  list.push(`[${SURFACE_ATTR}="${surface}"]:not([${HINT_ATTR}])`);
  // A bare name the page marks as a control (data-clipa-target="review-board") before the workspace fallback.
  if (!target.hint) for (const selector of uiSelectors(target.surface)) list.push(selector);
  list.push(`[${SURFACE_ATTR}="workspace"]`);
  return list;
}

export function resolveClipaTarget(root: QueryRoot, target: ClipaTarget): RectLike | null {
  for (const selector of selectorsFor(target)) {
    let el: Element | null = null;
    try {
      el = root.querySelector(selector);
    } catch {
      el = null; // a name that makes an invalid selector
    }
    const rect = visibleRect(el);
    if (rect !== null) return rect;
  }
  return null;
}
