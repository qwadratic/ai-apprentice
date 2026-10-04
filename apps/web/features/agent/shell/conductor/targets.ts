// Where a conductor cue points, in page coordinates.
//   - A UI target `{kind: 'ui', name, mode?}` is an element marked `data-clipa-target="<name>"` (and `data-mode="<mode>"`
//     when the target names a mode). The marks: share (ScreenSlot), start (the Start button), mode_tab (one per stage of the
//     journey rail, with data-mode), board_gap and teachback (Review), summary (Teach).
//   - A region target is a box normalised 0..1 to the frame the vision step read. The web maps it onto the live screen
//     preview (the processed canvas of the screen panel, which keeps the frame's aspect ratio).
// Pure lookups over a query root, so they are unit-tested without a browser.
import type { Box, Target, UiTarget } from './protocol.ts';

export const TARGET_ATTR = 'data-clipa-target';
/** The ScreenSlot box that holds the screen panel; the preview canvas is inside it. */
export const SCREEN_MOUNT_ATTR = 'data-clipa-screen';
/** The director's surface for conductor targets: the hint is `ui:<name>[:<mode>]` or `region:<regionId>`. */
export const CONDUCTOR_SURFACE = 'conductor';

export interface Rect { left: number; top: number; width: number; height: number }

interface ElementLike { getBoundingClientRect(): Rect }
export interface QueryRoot { querySelector(selector: string): ElementLike | null }

const esc = (value: string): string => value.replace(/["\\]/g, '\\$&');

/** Selectors for a UI target, most specific first, with fallbacks for markup that has no mark yet. */
export function uiSelectors(target: UiTarget): string[] {
  const name = esc(target.name);
  const list: string[] = [];
  if (target.mode) {
    const mode = esc(target.mode);
    list.push(`[${TARGET_ATTR}="${name}"][data-mode="${mode}"]`);
    // A stage of the journey rail by its mode: the rail's own "next" mark may name another stage than this cue.
    if (target.name === 'mode_tab') list.push(`#as-tab-${mode}`, `[${TARGET_ATTR}="stage-${mode}"]`);
  }
  list.push(`[${TARGET_ATTR}="${name}"]`);
  if (target.name === 'start') list.push('.as-session .as-btn--primary');
  return list;
}

function visible(el: ElementLike | null): Rect | null {
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}

export function resolveUiTarget(root: QueryRoot, target: UiTarget): Rect | null {
  for (const selector of uiSelectors(target)) {
    const rect = visible(root.querySelector(selector));
    if (rect !== null) return rect;
  }
  return null;
}

/** The live screen preview: the screen panel's processed canvas (or a video), inside the ScreenSlot mount. */
export function previewRect(root: QueryRoot): Rect | null {
  for (const selector of [
    `[${SCREEN_MOUNT_ATTR}] .screen-panel__preview canvas`,
    `[${SCREEN_MOUNT_ATTR}] canvas`,
    `[${SCREEN_MOUNT_ATTR}] video`,
  ]) {
    const rect = visible(root.querySelector(selector));
    if (rect !== null) return rect;
  }
  return null;
}

/** A normalised box on a frame shown in `frame` (page coordinates). */
export function boxRect(frame: Rect, box: Box): Rect {
  const [x, y, w, h] = box;
  return { left: frame.left + x * frame.width, top: frame.top + y * frame.height, width: w * frame.width, height: h * frame.height };
}

export function resolveTarget(root: QueryRoot, target: Target): Rect | null {
  if (target.kind === 'ui') return resolveUiTarget(root, target);
  if (target.box === null) return previewRect(root);
  const frame = previewRect(root);
  return frame === null ? null : boxRect(frame, target.box);
}

/** The director's target for a conductor target. */
export function clipaHint(target: Target): string {
  return target.kind === 'ui' ? `ui:${target.name}${target.mode ? `:${target.mode}` : ''}` : `region:${target.regionId}`;
}
