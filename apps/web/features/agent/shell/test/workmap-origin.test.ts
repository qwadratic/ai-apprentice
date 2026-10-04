// Reflect always has a session to explore: when the session has no map of its own, the conductor sends a copy of an earlier
// session's map or the synthetic demo map, and the map cue says which (`origin`, additive). The board shows a small tag for
// the two fallbacks and none for the session's own map. The board loads through the test-only esbuild hooks.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCue } from '../conductor/protocol.ts';
import { fromGenericMap } from '../../workmap/generic.ts';
import type { WorkMapBoardProps } from '../../workmap/WorkMapBoard.tsx';

register('../journey/tsx-hooks.mjs', import.meta.url);
const { WorkMapBoard } = (await import('../../workmap/WorkMapBoard.tsx')) as { WorkMapBoard: ComponentType<WorkMapBoardProps> };

/** A synthetic map in the conductor's generic shape, without screen moments (as the demo map is). */
const MAP = {
  processes: [{ id: 'p1', title: 'Invoice email: payment terms', summary: '' }],
  steps: [{ id: 's1', processId: 'p1', kind: 'judgment', goal: 'Give Lumen its terms', action: 'Changed "Net 14" to "Net 30"', decision: { summary: 'Net 30 for Lumen', reason: 'Signed agreement', quote: 'Lumen has a signed agreement for Net 30.' }, evidenceIds: [] }],
  guardrails: [{ id: 'g1', processId: 'p1', condition: 'Terms other than Net 14', requiredAction: 'Net 30 only for Lumen; longer terms need the finance lead', reason: 'Only Lumen has an agreement', quote: 'Net 30 is only for Lumen.', escalateTo: 'the finance lead', exceptions: [], evidenceIds: [] }],
  gaps: [],
  teachBack: 'Net 14 is standard; Net 30 only for Lumen. Is that right?',
};

function render(origin: WorkMapBoardProps['origin']): string {
  const board = fromGenericMap(MAP, { version: 1, observations: [] });
  assert.ok(board !== null);
  return renderToStaticMarkup(createElement(WorkMapBoard, { map: board.map, observations: [], gaps: board.gaps, ...(origin === undefined ? {} : { origin }) }));
}

test('the board tags a map from an earlier session and the synthetic demo map; the session\'s own map has no tag', () => {
  const demo = render('demo');
  assert.match(demo, /<span class="wm-tag wm-tag--synthetic wm-tag--demo" data-origin="demo">Demo session \(synthetic\)<\/span>/);
  assert.doesNotMatch(demo, /Earlier session/);
  const earlier = render('earlier');
  assert.match(earlier, /<span class="wm-tag wm-tag--earlier" data-origin="earlier">Earlier session<\/span>/);
  assert.doesNotMatch(earlier, /Demo session/);
  for (const html of [render('session'), render(undefined)]) assert.doesNotMatch(html, /data-origin=/);
  // The map itself renders as usual under the tag.
  assert.match(demo, /Net 30 only for Lumen/);
});

test('the map cue carries its origin; a missing or unknown origin is the session\'s own map', () => {
  const cue = (origin?: unknown) => parseCue({ type: 'map', version: 2, map: MAP, confirmed: false, ...(origin === undefined ? {} : { origin }) });
  assert.deepEqual(cue('demo'), { type: 'map', version: 2, map: MAP, confirmed: false, origin: 'demo' });
  assert.equal((cue('earlier') as { origin?: string }).origin, 'earlier');
  assert.equal((cue() as { origin?: string }).origin, 'session');
  assert.equal((cue('elsewhere') as { origin?: string }).origin, 'session');
});
