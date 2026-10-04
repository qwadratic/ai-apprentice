/*
 * Targets: how a data-clipa-target value reaches the Clipa director.
 *
 * The journey names controls by the value of their `data-clipa-target` attribute ("share-screen", "send", ...).
 * The director takes `{ surface, hint }` targets and asks its own resolveTarget for a rect, so the journey sends
 * `{ surface: 'journey', hint: value }` and the shell builds the director with createJourneyTargetResolver, which
 * answers those and hands every other target (the brain's surfaces) to the resolver the shell already has.
 */
import type { ClipaTarget, RectLike } from '../src/types.ts';

export const JOURNEY_SURFACE = 'journey';
export const TARGET_ATTRIBUTE = 'data-clipa-target';

export function journeyClipaTarget(value: string): ClipaTarget {
  return { surface: JOURNEY_SURFACE, hint: value };
}

/** The part of a Document the resolvers use, so tests can pass a plain object. */
export interface TargetRoot {
  querySelectorAll(selector: string): ArrayLike<TargetElement>;
}

export interface TargetElement {
  getBoundingClientRect(): RectLike;
  hidden?: boolean;
}

function attributeSelector(value: string): string {
  return `[${TARGET_ATTRIBUTE}="${value.replace(/["\\]/g, '\\$&')}"]`;
}

/**
 * The viewport rect of the first visible element carrying data-clipa-target="value", or null when there is none
 * (not mounted, hidden, or zero size). The first match wins, so a list marks only the item Clipa should point at.
 */
export function createDomTargetResolver(root: TargetRoot): (value: string) => RectLike | null {
  return (value) => {
    const found = root.querySelectorAll(attributeSelector(value));
    for (let i = 0; i < found.length; i += 1) {
      const el = found[i];
      if (!el || el.hidden) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
    }
    return null;
  };
}

/** The director's resolveTarget: journey targets by attribute value, everything else through `other`. */
export function createJourneyTargetResolver(
  byValue: (value: string) => RectLike | null,
  other?: (target: ClipaTarget) => RectLike | null,
): (target: ClipaTarget) => RectLike | null {
  return (target) => {
    if (target.surface === JOURNEY_SURFACE) return target.hint ? byValue(target.hint) : null;
    return other ? other(target) : null;
  };
}
