// Clipa everywhere (TASK-3.47): UI targets by data-clipa-target, and the geometry of resting on the rail (the director's anchor).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANCHOR_MAX_SCALE, ANCHOR_MIN_SCALE, anchorRest, anchorVisible } from '../../clipa/src/geometry.ts';
import { HINT_ATTR, SURFACE_ATTR, TARGET_ATTR, nameVariants, resolveClipaTarget, selectorsFor, uiTargetName } from '../clipa/targets.ts';

type Rect = { left: number; top: number; width: number; height: number };

function rootWith(elements: Record<string, Rect>): { querySelector(sel: string): Element | null } {
  return { querySelector: (sel: string) => (elements[sel] ? ({ getBoundingClientRect: () => elements[sel] } as unknown as Element) : null) };
}

test('workspace targets keep their lookup: hint, surface, workspace', () => {
  assert.deepEqual(selectorsFor({ surface: 'email', hint: 'send' }), [
    `[${SURFACE_ATTR}="email"][${HINT_ATTR}="send"]`, `[${SURFACE_ATTR}="email"]:not([${HINT_ATTR}])`, `[${SURFACE_ATTR}="workspace"]`,
  ]);
});

test('a UI target names a control by data-clipa-target, with _ and - alike, and never falls back to the workspace', () => {
  assert.equal(uiTargetName({ surface: 'ui', hint: 'board_gap' }), 'board_gap');
  assert.equal(uiTargetName({ surface: 'journey', hint: 'review-board' }), 'review-board');
  assert.equal(uiTargetName({ surface: 'email', hint: 'send' }), null);
  assert.deepEqual(nameVariants('board_gap'), ['board_gap', 'board-gap']);
  assert.deepEqual(nameVariants('mode'), ['mode']);

  const gap = { left: 40, top: 300, width: 200, height: 60 };
  const root = rootWith({ [`[${TARGET_ATTR}="board-gap"]`]: gap, [`[${SURFACE_ATTR}="workspace"]`]: { left: 0, top: 0, width: 900, height: 600 } });
  assert.equal(resolveClipaTarget(root, { surface: 'ui', hint: 'board_gap' }), gap, 'the conductor name finds the board\'s hyphenated mark');
  assert.equal(resolveClipaTarget(root, { surface: 'ui', hint: 'teachback' }), null, 'no workspace fallback for a UI name');
  assert.deepEqual(selectorsFor({ surface: 'ui' }), [], 'a UI target without a name resolves to nothing');
});

test('UI names have fallbacks for controls without the attribute; a bare surface also finds a data-clipa-target mark', () => {
  const start = { left: 900, top: 140, width: 120, height: 36 };
  assert.equal(resolveClipaTarget(rootWith({ '.as-session .as-btn--primary': start }), { surface: 'ui', hint: 'start' }), start);
  const stage = { left: 500, top: 10, width: 56, height: 56 };
  assert.equal(resolveClipaTarget(rootWith({ [`[${TARGET_ATTR}="mode_tab"]`]: stage }), { surface: 'ui', hint: 'mode_tab' }), stage);
  const board = { left: 10, top: 200, width: 800, height: 500 };
  assert.equal(resolveClipaTarget(rootWith({ [`[${TARGET_ATTR}="review-board"]`]: board }), { surface: 'review-board' }), board);
  const bad = { querySelector: (): Element | null => { throw new Error('invalid selector'); } };
  assert.equal(resolveClipaTarget(bad, { surface: 'ui', hint: 'x' }), null, 'an invalid selector is skipped');
});

const VP = { w: 1280, h: 800 };
const BODY = { w: 76.8, h: 96 };

test('Clipa rests centred on the anchor, as tall as it within limits', () => {
  const seat = { x: 600, y: 20, w: 56, h: 56 };
  const rest = anchorRest(seat, VP, BODY, 12);
  assert.ok(Math.abs(rest.scale - 56 / 96) < 1e-9);
  assert.deepEqual(rest.center, { x: 628, y: 48 });
  assert.equal(anchorRest({ ...seat, y: 2 }, VP, BODY, 12).center.y, 12 + 28, 'kept a margin below the top edge');
  assert.equal(anchorRest({ ...seat, h: 4 }, VP, BODY, 12).scale, ANCHOR_MIN_SCALE);
  assert.equal(anchorRest({ ...seat, h: 400 }, VP, BODY, 12).scale, ANCHOR_MAX_SCALE);
});

test('standing up on the anchor keeps her inside the viewport', () => {
  const seat = { x: 600, y: 4, w: 56, h: 56 };
  const hit = { w: 88.8, h: 108 };
  const stand = anchorRest(seat, VP, hit, 12, 1);
  assert.equal(stand.scale, 1);
  assert.equal(stand.center.x, 628);
  assert.equal(stand.center.y, 12 + 54, 'pushed down so her head stays on screen');
  const corner = anchorRest({ x: 1260, y: 780, w: 56, h: 56 }, VP, hit, 12, 1);
  assert.ok(corner.center.x + hit.w / 2 <= VP.w - 12 && corner.center.y + hit.h / 2 <= VP.h - 12);
});

test('an anchor counts only while at least half of it is on screen', () => {
  assert.equal(anchorVisible({ x: 600, y: 10, w: 56, h: 56 }, VP), true);
  assert.equal(anchorVisible({ x: 600, y: -40, w: 56, h: 56 }, VP), false, 'scrolled mostly out of view');
  assert.equal(anchorVisible({ x: 600, y: -20, w: 56, h: 56 }, VP), true);
  assert.equal(anchorVisible({ x: 600, y: 10, w: 0, h: 0 }, VP), false, 'hidden');
});
