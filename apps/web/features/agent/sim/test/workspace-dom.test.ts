import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRng } from '../clock.ts';
import { DEMO_SELECTORS, createDemoWorkspaceActions } from '../workspace-dom.ts';
import type { DomPort } from '../workspace-dom.ts';
import { VirtualClock } from './helpers.ts';

type Calls = string[];

/** A page as the workspace renders it, reduced to what the adapter reads and writes. */
class FakePage implements DomPort {
  readonly calls: Calls = [];
  values = new Map<string, string>([
    [DEMO_SELECTORS.caseSelect, 'practice'],
    [DEMO_SELECTORS.orderCustomer, 'customer_07'],
    [DEMO_SELECTORS.address, '14 Sample Lane, 1010 Exampletown'],
    [DEMO_SELECTORS.window, '2026-10-12 14:00-16:00'],
    [DEMO_SELECTORS.body, 'Hello,\n\nPlease see the attached delivery summary.'],
    [DEMO_SELECTORS.ticket, ''],
  ]);
  texts = new Map<string, string>([
    [DEMO_SELECTORS.orderTitle, 'ORD-2041'],
    [DEMO_SELECTORS.checkMessage, ''],
    [DEMO_SELECTORS.sent, ''],
  ]);
  attrs = new Map<string, string>([[`${DEMO_SELECTORS.checkPanel}|data-status`, 'idle']]);
  counts = new Map<string, number>([[DEMO_SELECTORS.attachmentFigure, 1]]);
  disabled = new Set<string>();
  hidden = new Set<string>([DEMO_SELECTORS.ackPanel]);
  checked = new Set<string>();
  knownCases = new Set(['practice', 'new-image']);
  /** What a click does, like the workspace's own handlers. */
  onClick = new Map<string, () => void>();

  exists(selector: string): boolean {
    return this.values.has(selector) || this.texts.has(selector) || this.counts.has(selector);
  }
  count(selector: string): number {
    return this.counts.get(selector) ?? 0;
  }
  text(selector: string): string {
    return this.texts.get(selector) ?? '';
  }
  attr(selector: string, name: string): string | null {
    return this.attrs.get(`${selector}|${name}`) ?? null;
  }
  value(selector: string): string {
    return this.values.get(selector) ?? '';
  }
  isChecked(selector: string): boolean {
    return this.checked.has(selector);
  }
  isDisabled(selector: string): boolean {
    return this.disabled.has(selector);
  }
  isHidden(selector: string): boolean {
    return this.hidden.has(selector);
  }
  pointAt(selector: string): Promise<void> {
    this.calls.push(`point:${selector}`);
    return Promise.resolve();
  }
  click(selector: string): void {
    this.calls.push(`click:${selector}`);
    this.onClick.get(selector)?.();
  }
  focus(selector: string): void {
    this.calls.push(`focus:${selector}`);
  }
  setValue(selector: string, value: string, event: 'input' | 'change'): void {
    this.calls.push(`${event}:${selector}`);
    if (selector === DEMO_SELECTORS.caseSelect && !this.knownCases.has(value)) {
      this.values.set(selector, '');
      return;
    }
    this.values.set(selector, value);
  }
}

function setup() {
  const clock = new VirtualClock();
  const page = new FakePage();
  const actions = createDemoWorkspaceActions({ port: page, clock, rng: createRng(3) });
  return { clock, page, actions };
}

test('openOrder picks the case in the select with a change event and fails for a case that does not exist', async () => {
  const { clock, page, actions } = setup();
  await clock.run(actions.openOrder('new-image'));
  assert.ok(page.calls.includes(`change:${DEMO_SELECTORS.caseSelect}`));
  assert.equal(page.value(DEMO_SELECTORS.caseSelect), 'new-image');
  await assert.rejects(clock.run(actions.openOrder('no-such-case')), /no case "no-such-case"/);
});

test('the persona reads the order from the screen fields', () => {
  const { actions } = setup();
  assert.deepEqual(actions.readOrder(), {
    orderId: 'ORD-2041',
    customer: 'customer_07',
    address: '14 Sample Lane, 1010 Exampletown',
    window: '2026-10-12 14:00-16:00',
  });
  assert.deepEqual(actions.readEmail(), { body: 'Hello,\n\nPlease see the attached delivery summary.', attachments: 1 });
});

test('removeImage points at the Remove image button, waits a reaction time and clicks; with no image it does nothing', async () => {
  const { clock, page, actions } = setup();
  page.onClick.set(DEMO_SELECTORS.removeImage, () => page.counts.set(DEMO_SELECTORS.attachmentFigure, 0));
  await clock.run(actions.removeImage());
  assert.deepEqual(page.calls, [`point:${DEMO_SELECTORS.removeImage}`, `click:${DEMO_SELECTORS.removeImage}`]);
  assert.ok(clock.now() > 0, 'a reaction time passed between pointing and clicking');
  assert.equal(actions.readEmail().attachments, 0);
  page.calls.length = 0;
  await clock.run(actions.removeImage());
  assert.deepEqual(page.calls, []);
});

test('typeText replaces by clearing once and then typing key by key with an input event for every key', async () => {
  const { clock, page, actions } = setup();
  await clock.run(actions.typeText('body', 'Hi.\nBye', 'replace'));
  const inputs = page.calls.filter((c) => c === `input:${DEMO_SELECTORS.body}`);
  assert.equal(inputs.length, 1 + 'Hi.\nBye'.length, 'one clearing edit and one per character');
  assert.equal(page.value(DEMO_SELECTORS.body), 'Hi.\nBye');
  assert.ok(page.calls.indexOf(`focus:${DEMO_SELECTORS.body}`) < page.calls.indexOf(`input:${DEMO_SELECTORS.body}`));
});

test('typeText appends to what is there and types the ticket note into its own field', async () => {
  const { clock, page, actions } = setup();
  await clock.run(actions.typeText('body', ' More.', 'append'));
  assert.equal(page.value(DEMO_SELECTORS.body), 'Hello,\n\nPlease see the attached delivery summary. More.');
  await clock.run(actions.typeText('ticket', 'Done.', 'replace'));
  assert.equal(page.value(DEMO_SELECTORS.ticket), 'Done.');
});

test('typing takes human time: the clock moves for every key', async () => {
  const { clock, actions } = setup();
  await clock.run(actions.typeText('ticket', 'ORD-2041: details sent.', 'replace'));
  assert.ok(clock.now() > 23 * 85, `${clock.now()} ms for 23 keys`);
});

test('waitForCheck waits while the check is pending and returns the status the panel shows', async () => {
  const { clock, page, actions } = setup();
  const statusKey = `${DEMO_SELECTORS.checkPanel}|data-status`;
  page.attrs.set(statusKey, 'pending');
  const waiting = actions.waitForCheck(30_000);
  const done = clock.run(waiting);
  // The agent answers after about two seconds.
  await clock.advance(2000);
  page.attrs.set(statusKey, 'warn');
  page.texts.set(DEMO_SELECTORS.checkMessage, ' The expert would stop here. ');
  assert.deepEqual(await done, { status: 'warn', message: 'The expert would stop here.' });
});

test('waitForCheck gives up at the timeout and reports the check as it is', async () => {
  const { clock, page, actions } = setup();
  page.attrs.set(`${DEMO_SELECTORS.checkPanel}|data-status`, 'pending');
  const result = await clock.run(actions.waitForCheck(3000));
  assert.equal(result.status, 'pending');
  assert.ok(clock.now() >= 3000);
});

test('an unknown status in the panel is reported as an error, never as clear', () => {
  const { page, actions } = setup();
  page.attrs.set(`${DEMO_SELECTORS.checkPanel}|data-status`, 'allowed');
  assert.equal(actions.checkResult().status, 'error');
});

test('acknowledge ticks the box only when the warning panel is showing and the box is not ticked yet', async () => {
  const { clock, page, actions } = setup();
  await clock.run(actions.acknowledge());
  assert.ok(!page.calls.some((c) => c.startsWith('click:')), 'the panel is hidden: nothing to acknowledge');
  page.hidden.delete(DEMO_SELECTORS.ackPanel);
  await clock.run(actions.acknowledge());
  assert.ok(page.calls.includes(`click:${DEMO_SELECTORS.ack}`));
  page.calls.length = 0;
  page.checked.add(DEMO_SELECTORS.ack);
  await clock.run(actions.acknowledge());
  assert.deepEqual(page.calls, []);
});

test('send does not click a disabled Send button; with Send enabled it reports whether the email went out', async () => {
  const { clock, page, actions } = setup();
  page.disabled.add(DEMO_SELECTORS.send);
  assert.equal(await clock.run(actions.send()), false);
  assert.ok(!page.calls.includes(`click:${DEMO_SELECTORS.send}`));
  page.disabled.delete(DEMO_SELECTORS.send);
  page.onClick.set(DEMO_SELECTORS.send, () => page.texts.set(DEMO_SELECTORS.sent, 'Demo email sent locally. No real email was sent.'));
  assert.equal(await clock.run(actions.send()), true);
  assert.equal(actions.isSent(), true);
});

test('selectors can be overridden when the workspace markup changes', async () => {
  const clock = new VirtualClock();
  const page = new FakePage();
  page.values.set('#msg', 'x');
  const actions = createDemoWorkspaceActions({ port: page, clock, selectors: { body: '#msg' } });
  assert.equal(actions.readEmail().body, 'x');
});
