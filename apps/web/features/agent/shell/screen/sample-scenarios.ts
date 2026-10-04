// The scripts of the sample observation source. All data is invented and every observation is labelled synthetic in the
// shell. Nothing here is a rule, a question or a warning: only what a screen would show (an order, an email draft, a ticket
// and the workspace's typing heartbeats). The brain has to derive everything else from the expert's answers.
//
//   learn  the expert's run on order ORD-2041 for customer_07: the data of fixtures/agent/learn-customer07.json (one source of
//          truth, imported as it is). The recipient is the visible customer_07, as in the demo workspace.
//   t1-t4  Teach cases on orders the expert never showed. They mirror the cases of the demo workspace (stream A): the same
//          customers, order ids, addresses and windows, so that swapping the workspace in changes nothing for the person.
//
// The sample source is a stand-in until the real ScreenBridge and the demo workspace are wired in (doc-9).
import type { ScreenEvidence, ScreenObservation } from '@apprentice/contracts';
import { SCHEMA_VERSION, parseScreenEvidence, parseScreenObservation } from '@apprentice/contracts';
import { createScreenFixtures } from '@apprentice/contracts/fixtures';
import learn from '../../../../../../fixtures/agent/learn-customer07.json' with { type: 'json' };

export interface SampleFixture {
  observations: ScreenObservation[];
  evidence: ScreenEvidence[];
}

/** The customers the demo workspace and the sample know. A spoken "customer seven" is mapped onto one of these, never invented. */
export const SAMPLE_CUSTOMERS: readonly string[] = ['customer_07', 'customer_03', 'customer_09', 'customer_12'];

export const SAMPLE_LEARN_LABEL = 'Sample observations (synthetic): customer_07 order';

export type TeachCaseId = 't1' | 't2' | 't3' | 't4';
export type SampleScenarioId = 'neutral' | 'learn' | TeachCaseId;

export interface TeachCase {
  id: TeachCaseId;
  /** What the person sees in the case selector. Neutral: no hint at the expected result. */
  title: string;
  customerRef: string | null;
  orderId: string;
  deliveryAddress: string;
  deliveryWindow: string;
  /** What the new hire's draft holds when the case starts. */
  bodyText: string;
  attachTemplateImage: boolean;
}

const fullText = (orderId: string, address: string, window: string): string =>
  `Hello,\n\nHere are your delivery details.\nOrder: ${orderId}\nDelivery address: ${address}\nDelivery window: ${window}\n\nKind regards,\nDemo operations`;
const imageOnly = 'Hello,\n\nPlease see the attached delivery summary.\n\nKind regards,\nDemo operations';

export const TEACH_CASES: readonly TeachCase[] = [
  {
    id: 't1', title: 'New order, customer_07, image attached', customerRef: 'customer_07', orderId: 'ORD-2057',
    deliveryAddress: '82 Sample Walk, 1010 Exampletown', deliveryWindow: '2026-10-13 09:00-11:00', bodyText: imageOnly, attachTemplateImage: true,
  },
  {
    id: 't2', title: 'New order, customer_07, details typed and image attached', customerRef: 'customer_07', orderId: 'ORD-2057',
    deliveryAddress: '82 Sample Walk, 1010 Exampletown', deliveryWindow: '2026-10-13 09:00-11:00',
    bodyText: fullText('ORD-2057', '82 Sample Walk, 1010 Exampletown', '2026-10-13 09:00-11:00'), attachTemplateImage: true,
  },
  {
    id: 't3', title: 'Order for customer_03', customerRef: 'customer_03', orderId: 'DEMO-3001',
    deliveryAddress: '9 Amber Avenue, Sample City', deliveryWindow: '7 Oct 2026, 10:00-12:00', bodyText: imageOnly, attachTemplateImage: true,
  },
  {
    id: 't4', title: 'Order for a customer that is not recognised', customerRef: null, orderId: 'DEMO-U001',
    deliveryAddress: '31 Cloud Court, Sample City', deliveryWindow: '8 Oct 2026, 15:00-17:00', bodyText: imageOnly, attachTemplateImage: true,
  },
];

export function isTeachCaseId(value: unknown): value is TeachCaseId {
  return TEACH_CASES.some((c) => c.id === value);
}

export function teachCase(id: TeachCaseId): TeachCase {
  const found = TEACH_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown sample case ${id}`);
  return found;
}

export function scenarioLabel(id: SampleScenarioId): string {
  if (id === 'neutral') return 'Sample observations (synthetic)';
  if (id === 'learn') return SAMPLE_LEARN_LABEL;
  return `Sample observations (synthetic): ${teachCase(id).title}`;
}

/** The unchanged neutral fixture of TASK-3.8: the contracts' sample without the unknown-order observation. */
function neutralFixture(sessionId: string): SampleFixture {
  const all = createScreenFixtures(sessionId);
  const observations = all.observations.filter((o) => o.id !== 'order-unknown');
  const used = new Set(observations.flatMap((o) => o.evidenceIds));
  return { observations, evidence: all.evidence.filter((e) => used.has(e.id)) };
}

/** fixtures/agent/learn-customer07.json as a session of the given id. */
function learnFixture(sessionId: string): SampleFixture {
  const evidence = learn.evidence.map((e) => parseScreenEvidence({
    schemaVersion: SCHEMA_VERSION, id: e.id, kind: e.kind, assetRef: `mock://sample/${encodeURIComponent(sessionId)}/${e.id}`,
    startMs: e.startOffsetMs, endMs: e.endOffsetMs,
  }));
  const observations = learn.observations.map((o, i) => parseScreenObservation({
    schemaVersion: SCHEMA_VERSION, id: o.id, sessionId, sequence: i + 1, timestampMs: o.atMs, source: o.source, frameId: o.frameId,
    sourceRevision: o.sourceRevision, kind: o.kind, facts: o.facts, entityRef: o.entityRef, evidenceIds: o.evidenceIds,
  }));
  return { observations, evidence };
}

/** A Teach case: the order opens, the draft appears, then the draft is in Preview (what the checkpoint rests on). */
function teachFixture(c: TeachCase, sessionId: string): SampleFixture {
  const id = c.id;
  const span = (at: number): { startMs: number; endMs: number } => ({ startMs: at, endMs: at + 1000 });
  const evidence = [0, 1500, 4000].map((at, i) => parseScreenEvidence({
    schemaVersion: SCHEMA_VERSION, id: `ev-${id}-${i + 1}`, kind: 'frame', assetRef: `mock://sample/${encodeURIComponent(sessionId)}/ev-${id}-${i + 1}`, ...span(at),
  }));
  const base = { schemaVersion: SCHEMA_VERSION, sessionId, source: 'vision' as const, entityRef: c.customerRef };
  const draft = (previewState: 'editing' | 'preview') => ({
    recipientRef: c.customerRef,
    subject: `Delivery update - ${c.orderId}`,
    bodyText: c.bodyText,
    attachments: c.attachTemplateImage ? [{ kind: 'image' as const, ocrText: `Delivery summary ${c.orderId} | ${c.deliveryAddress} | ${c.deliveryWindow}` }] : [],
    previewState,
  });
  const observations = [
    parseScreenObservation({
      ...base, id: `${id}-order`, sequence: 1, timestampMs: 0, frameId: `${id}-f1`, sourceRevision: `${id}-order-r1`, kind: 'order_view', evidenceIds: [`ev-${id}-1`],
      facts: { customerRef: c.customerRef, orderId: c.orderId, deliveryAddress: c.deliveryAddress, deliveryWindow: c.deliveryWindow },
    }),
    parseScreenObservation({
      ...base, id: `${id}-email-1`, sequence: 2, timestampMs: 1500, frameId: `${id}-f2`, sourceRevision: `${id}-email-r1`, kind: 'email_draft', evidenceIds: [`ev-${id}-2`],
      facts: draft('editing'),
    }),
    parseScreenObservation({
      ...base, id: `${id}-email-2`, sequence: 3, timestampMs: 4000, frameId: `${id}-f3`, sourceRevision: `${id}-email-r2`, kind: 'email_draft', evidenceIds: [`ev-${id}-3`],
      facts: draft('preview'),
    }),
  ];
  return { observations, evidence };
}

/** The fixture of a scenario for a session id. Pure: the same inputs give the same observations. */
export function buildScenario(id: SampleScenarioId, sessionId: string): SampleFixture {
  if (id === 'neutral') return neutralFixture(sessionId);
  if (id === 'learn') return learnFixture(sessionId);
  return teachFixture(teachCase(id), sessionId);
}
