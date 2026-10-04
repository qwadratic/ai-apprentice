import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObservation } from '../agent/conductor/protocol.ts';
import type { SeenObservation } from '../agent/conductor/protocol.ts';

// All data here is synthetic.
function seen(kind: string, facts: unknown, id = 'obs-1'): SeenObservation {
  const r = parseObservation({ id, kind, timestampMs: 1200, evidenceIds: ['ev-1'], facts });
  assert.ok(r.ok, `parse failed: ${r.ok ? '' : r.field}`);
  return r.value;
}
const DRAFT = { recipientRef: 'customer_07', subject: 'Your order ORD-2041', bodyText: '', attachments: [], previewState: 'editing' };

test('email_draft: the typed body survives, whitespace collapsed, at most 300 characters', () => {
  const line = 'Delivery address: Example Street 1, 1100 Vienna. Delivery window: Tuesday 10-12.';
  const body = `Hello,\n\n${line}\n\t${line}`.padEnd(150, ' x');
  assert.ok(body.length >= 140);
  const o = seen('email_draft', { ...DRAFT, bodyText: body });
  const collapsed = body.replace(/\s+/g, ' ').trim();
  assert.ok(o.summary.includes(`body: ${collapsed};`), o.summary);
  assert.ok(o.summary.startsWith('to customer_07; subject Your order ORD-2041; body: Hello, Delivery address:'), o.summary);
  assert.ok(o.summary.endsWith('; attachments: none; state editing'), o.summary);
  assert.equal(o.surface, 'email draft');

  const long = seen('email_draft', { ...DRAFT, subject: 's'.repeat(300), bodyText: `${'word '.repeat(400)}\u0001end` });
  const cut = /body: (.*); attachments:/.exec(long.summary)?.[1] ?? '';
  assert.ok(cut.length > 0 && cut.length <= 300 && cut.endsWith('…'), cut);
  assert.ok(long.summary.length <= 400, `summary is ${long.summary.length} characters`);
  assert.ok(!/[\u0000-\u001f]/.test(long.summary), 'no control characters reach the LLM tasks');
});

test('email_draft: attachments are named, or none', () => {
  assert.match(seen('email_draft', { ...DRAFT, attachments: [{ kind: 'image', ocrText: 'ignored' }] }).summary, /; attachments: image; state editing$/);
  assert.match(seen('email_draft', { ...DRAFT, attachments: [{ kind: 'image' }, { kind: 'pdf' }] }).summary, /; attachments: image, pdf;/);
  assert.match(seen('email_draft', DRAFT).summary, /; attachments: none;/);
  assert.match(seen('email_draft', { ...DRAFT, attachments: [{ kind: 'Not A Kind!' }, 'x'] }).summary, /; attachments: other, other;/);
});

test('email_draft: a preview means the person is about to use Send', () => {
  const preview = seen('email_draft', { ...DRAFT, previewState: 'preview' });
  assert.equal(preview.pendingAction, 'Send');
  assert.match(preview.summary, /; state preview$/);
  assert.equal(seen('email_draft', DRAFT).pendingAction, null);
  assert.equal(seen('email_draft', { ...DRAFT, previewState: 'sent' }).pendingAction, null);
});

test('order_view: the summary names the order, the customer, the address and the window', () => {
  const o = seen('order_view', { orderId: 'ORD-2041', customerRef: 'customer_07', deliveryAddress: 'Example Street 1,\n1100 Vienna', deliveryWindow: 'Tue 10:00-12:00' });
  assert.equal(o.summary, 'order ORD-2041; customer customer_07; address Example Street 1, 1100 Vienna; window Tue 10:00-12:00');
  assert.equal(o.pendingAction, null);
  assert.equal(seen('order_view', { orderId: 'ORD-2057', customerRef: null, deliveryAddress: null, deliveryWindow: null }).summary,
    'order ORD-2057; customer unknown; address unknown; window unknown');
});

test('workspace facts of the wrong type do not throw and fall back to neutral words', () => {
  const email = seen('email_draft', { recipientRef: 42, subject: { x: 1 }, bodyText: ['a'], attachments: 'image', previewState: 'PREVIEW' });
  assert.equal(email.summary, 'to unknown; subject (none); body: (empty); attachments: none; state unknown');
  assert.equal(email.pendingAction, null);
  assert.equal(seen('order_view', { orderId: 7, customerRef: false, deliveryAddress: {}, deliveryWindow: [] }).summary,
    'order unknown; customer unknown; address unknown; window unknown');
  assert.equal(seen('order_view', null).summary, 'order unknown; customer unknown; address unknown; window unknown');
  assert.equal(seen('email_draft', 'not an object').summary, 'to unknown; subject (none); body: (empty); attachments: none; state unknown');
});

test('screen_activity and the ticket keep their summaries', () => {
  const o = seen('screen_activity', {
    app: 'Mail', surface: 'compose window', summary: 'A reply is open.', change: 'Subject changed', pendingAction: 'Send',
    regions: [{ id: 'r-to', label: 'recipient field', box: [0.1, 0.1, 0.3, 0.05] }],
  });
  assert.deepEqual(
    { app: o.app, surface: o.surface, summary: o.summary, change: o.change, pendingAction: o.pendingAction, regions: o.regions },
    { app: 'Mail', surface: 'compose window', summary: 'A reply is open.', change: 'Subject changed', pendingAction: 'Send',
      regions: [{ regionId: 'r-to', label: 'recipient field', box: [0.1, 0.1, 0.3, 0.05], evidenceId: 'ev-1' }] },
  );
  const ticket = seen('ticket', { ticketId: 'T-1', orderId: 'ORD-2041', customerRef: null, status: 'open', summary: 'Sent the reply.' });
  assert.equal(ticket.summary, 'ticketId T-1; orderId ORD-2041; status open; summary Sent the reply.');
});
