// The workflow strip: the expert's customer_07 workflow with Clipa's lane under it, rendered with react-dom/server. The .tsx
// components load through the test-only esbuild hooks in journey/tsx-hooks.mjs, registered here before the dynamic imports.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClipaStore } from '../clipa/presenter.ts';
import { createConductorStore } from '../conductor/store.ts';
import { ShellContext } from '../hooks.ts';
import type { ShellRuntime } from '../runtime.ts';
import { createStore } from '../state/store.ts';
import type { Store } from '../state/store.ts';
import type { Mode } from '../state/types.ts';

register('../journey/tsx-hooks.mjs', import.meta.url);
const { WorkflowStrip, WORKFLOW } = (await import('../components/WorkflowStrip.tsx')) as {
  WorkflowStrip: ComponentType<{ aside?: ReactNode }>;
  WORKFLOW: { title: string; steps: ReadonlyArray<{ title: string; ref: string | null }>; stages: ReadonlyArray<{ mode: Mode; name: string; markers: ReadonlyArray<{ text: string; from: number; span: number; shape: string; at: string }> }> };
};

function render(store: Store, aside?: ReactNode): string {
  const controller = { store, conductorStore: createConductorStore() };
  const runtime = { controller, clipa: createClipaStore(), workspace: null, live: null, dispose: () => {} } as unknown as ShellRuntime;
  return renderToStaticMarkup(createElement(ShellContext.Provider, { value: runtime }, createElement(WorkflowStrip, aside === undefined ? {} : { aside })));
}

const inMode = (mode: Mode): Store => {
  const store = createStore();
  store.dispatch({ type: 'MODE_SET', mode });
  return store;
};
const count = (html: string, needle: string): number => html.split(needle).length - 1;
const row = (html: string, stage: Mode): string => new RegExp(`<div class="ws__row ws__row--lane" data-stage="${stage}"[^>]*>`).exec(html)?.[0] ?? '';

test('the strip has the title and the five steps of the customer_07 case, in order', () => {
  const html = render(createStore());
  assert.match(html, /<h2 class="ws__title" id="ws-title">The expert’s workflow, and where Clipa fits<\/h2>/);
  assert.match(html, /aria-labelledby="ws-title"/);
  assert.equal(count(html, 'class="ws__step"'), 5);
  const names = [...html.matchAll(/<li class="ws__step"><span class="ws__no" aria-hidden="true">(\d)<\/span><span class="ws__name">([^<]*)(?:<span class="ws__ref">[^<]*<\/span>)?<\/span><\/li>/g)];
  assert.deepEqual(
    names.map((m) => [m[1], m[2]]),
    [['1', 'Open the order'], ['2', 'Read the customer’s note'], ['3', 'Write the delivery update'], ['4', 'Preview'], ['5', 'Send']],
  );
  assert.match(html, /Open the order<span class="ws__ref"> \(ORD-2041\)<\/span>/, 'the order of the case is named');
});

test('Clipa\'s lane: Show watches across steps 1 to 3 and asks after step 3; Reflect and Pass it on have their markers', () => {
  const html = render(createStore());
  assert.equal(count(html, 'class="ws__row ws__row--lane"'), 3, 'one lane row per stage');
  assert.match(html, />Show</);
  assert.match(html, />Reflect</);
  assert.match(html, />Pass it on</);
  // Each marker sits in the columns of its steps (--from, --span).
  assert.match(html, /<li class="ws__mark ws__mark--bar" style="--from:1;--span:3"><span class="ws__mark-text">watches quietly<\/span><span class="ws__at">steps 1–3<\/span><\/li>/);
  assert.match(html, /<li class="ws__mark ws__mark--pin" style="--from:4;--span:1"><span class="ws__mark-text">asks why at the pause<\/span><span class="ws__at">after step 3<\/span><\/li>/);
  assert.match(html, /<li class="ws__mark ws__mark--pin" style="--from:4;--span:2"><span class="ws__mark-text">the answer becomes a rule \+ exception<\/span>/);
  assert.match(html, /<li class="ws__mark ws__mark--pin" style="--from:5;--span:1"><span class="ws__mark-text">checks before Send<\/span><span class="ws__at">between steps 4 and 5<\/span><\/li>/);
});

test('the markers of the stage on screen are lit; the others are not', () => {
  for (const mode of ['learn', 'review', 'teach'] as const) {
    const html = render(inMode(mode));
    assert.match(html, new RegExp(`<section class="ws" aria-labelledby="ws-title" data-testid="workflow-strip" data-mode="${mode}">`));
    for (const other of ['learn', 'review', 'teach'] as const) {
      const tag = row(html, other);
      assert.match(tag, new RegExp(`data-current="${other === mode ? 'true' : 'false'}"`), `${other} while ${mode} is on screen`);
      assert.equal(/aria-current="true"/.test(tag), other === mode, 'the lit stage is also marked for screen readers');
    }
    assert.equal(count(html, 'data-current="true"'), 1, 'exactly one stage is lit');
  }
});

test('the aside (the recording pill) sits in the title row; without one the title stands alone', () => {
  const withAside = render(createStore(), createElement('span', { className: 'x-aside' }, 'Recording'));
  assert.match(withAside, /<\/h2><span class="x-aside">Recording<\/span><\/div>/);
  assert.doesNotMatch(render(createStore()), /x-aside/);
});

test('the steps and the lane live in one small config; every marker sits on real steps', () => {
  assert.equal(WORKFLOW.steps.length, 5);
  assert.deepEqual(WORKFLOW.stages.map((s) => s.mode), ['learn', 'review', 'teach']);
  for (const stage of WORKFLOW.stages) {
    assert.ok(stage.markers.length > 0);
    for (const m of stage.markers) {
      assert.ok(m.from >= 1 && m.from + m.span - 1 <= WORKFLOW.steps.length, `${m.text} stays inside the five columns`);
      assert.ok(m.at.length > 0, `${m.text} says where it sits in words`);
    }
  }
  const send = WORKFLOW.stages[2]!.markers[0]!;
  assert.equal(WORKFLOW.steps[send.from - 1]!.title, 'Send', 'Pass it on checks right before Send');
  const quiet = WORKFLOW.stages[0]!.markers[0]!;
  assert.deepEqual([quiet.from, quiet.span], [1, 3], 'Show watches quietly across steps 1 to 3');
  const asks = WORKFLOW.stages[0]!.markers[1]!;
  assert.equal(WORKFLOW.steps[asks.from - 2]!.title, 'Write the delivery update', 'Show asks after step 3');
});
