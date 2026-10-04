import type { ScreenEvidence, ScreenObservation } from './types.ts';
/** Neutral synthetic facts only. No personal rules, voice questions or tutor decisions. */
export function createScreenFixtures(sessionId = 'synthetic-session'): {observations: ScreenObservation[]; evidence: ScreenEvidence[]} {
  const base = {schemaVersion: 1 as const, sessionId};
  const observations: ScreenObservation[] = [
    {...base, id: 'order-1', sequence: 1, timestampMs: 1000, source: 'vision', frameId: 'frame-1', sourceRevision: 'order-r1', kind: 'order_view', entityRef: 'synthetic_customer_A', evidenceIds: ['evidence-1'], facts: {customerRef: 'synthetic_customer_A', orderId: 'SYN-101', deliveryAddress: '10 Example Lane, Demo City', deliveryWindow: '2026-10-04 10:00–12:00'}},
    {...base, id: 'input-1', sequence: 2, timestampMs: 2000, source: 'workspace', frameId: null, sourceRevision: null, kind: 'input_activity', entityRef: null, evidenceIds: [], facts: {surface: 'email', typing: true, idleMs: 0, lastInputAtMs: 2000}},
    {...base, id: 'email-1', sequence: 3, timestampMs: 3000, source: 'vision', frameId: 'frame-3', sourceRevision: 'email-r1', kind: 'email_draft', entityRef: 'synthetic_customer_A', evidenceIds: ['evidence-3'], facts: {recipientRef: 'synthetic_customer_A', subject: 'Synthetic delivery', bodyText: 'Delivery to 10 Example Lane, Demo City, 10:00–12:00.', attachments: [], previewState: 'preview'}},
    {...base, id: 'order-unknown', sequence: 4, timestampMs: 4000, source: 'vision', frameId: 'frame-4', sourceRevision: null, kind: 'order_view', entityRef: null, evidenceIds: ['evidence-4'], facts: {customerRef: null, orderId: null, deliveryAddress: null, deliveryWindow: null}},
    {...base, id: 'ticket-1', sequence: 5, timestampMs: 5000, source: 'vision', frameId: 'frame-5', sourceRevision: 'ticket-r1', kind: 'ticket', entityRef: null, evidenceIds: ['evidence-5'], facts: {customerRef: null, ticketId: 'SYN-T1', orderId: 'SYN-102', status: 'open', summary: 'Customer identity not visible.'}},
  ];
  const evidence: ScreenEvidence[] = observations.flatMap((o) => o.evidenceIds.map((id) => ({schemaVersion: 1, id, kind: 'frame', assetRef: `mock://${encodeURIComponent(sessionId)}/${id}`, startMs: o.timestampMs, endMs: o.timestampMs})));
  return {observations, evidence};
}
