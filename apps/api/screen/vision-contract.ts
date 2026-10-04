import {randomUUID} from 'node:crypto';
import type {EmailDraftFacts, OrderFacts, ScreenObservation, TicketFacts} from '@apprentice/contracts';
import type {ScreenEvidenceRecord} from './evidence-store.ts';
import type {VisionObservationContext, VisionSurface} from '../../../packages/screen/vision/queue.ts';

export type VisionResult =
  | {readonly outcome: 'observation'; readonly kind: 'order_view'; readonly facts: OrderFacts}
  | {readonly outcome: 'observation'; readonly kind: 'email_draft'; readonly facts: EmailDraftFacts}
  | {readonly outcome: 'observation'; readonly kind: 'ticket'; readonly facts: TicketFacts}
  | {readonly outcome: 'incomplete'; readonly reason: 'unreadable' | 'unsupported_surface'};

export const VISION_RESULT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  oneOf: [
    {type: 'object', required: ['outcome', 'kind', 'facts'], additionalProperties: false,
      properties: {outcome: {const: 'observation'}, kind: {const: 'order_view'}, facts: {type: 'object',
        required: ['customerRef', 'orderId', 'deliveryAddress', 'deliveryWindow'], additionalProperties: false,
        properties: {customerRef: nullableString(), orderId: nullableString(), deliveryAddress: nullableString(), deliveryWindow: nullableString()}}}},
    {type: 'object', required: ['outcome', 'kind', 'facts'], additionalProperties: false,
      properties: {outcome: {const: 'observation'}, kind: {const: 'email_draft'}, facts: {type: 'object',
        required: ['recipientRef', 'subject', 'bodyText', 'attachments', 'previewState'], additionalProperties: false,
        properties: {recipientRef: nullableString(), subject: {type: 'string'}, bodyText: {type: 'string'},
          attachments: {type: 'array', items: {type: 'object', required: ['kind'], additionalProperties: false,
            properties: {kind: {enum: ['image', 'pdf', 'other']}, ocrText: {type: 'string'}}}},
          previewState: {enum: ['editing', 'preview', 'sent']}}}}},
    {type: 'object', required: ['outcome', 'kind', 'facts'], additionalProperties: false,
      properties: {outcome: {const: 'observation'}, kind: {const: 'ticket'}, facts: {type: 'object',
        required: ['ticketId', 'orderId', 'customerRef', 'status', 'summary'], additionalProperties: false,
        properties: {ticketId: {type: 'string', minLength: 1}, orderId: nullableString(), customerRef: nullableString(),
          status: {enum: ['open', 'done']}, summary: {type: 'string'}}}}},
    {type: 'object', required: ['outcome', 'reason'], additionalProperties: false,
      properties: {outcome: {const: 'incomplete'}, reason: {enum: ['unreadable', 'unsupported_surface']}}},
  ],
});

export class VisionContractError extends Error {
  readonly code: 'invalid_model_output' | 'vision_incomplete';
  constructor(code: 'invalid_model_output' | 'vision_incomplete') { super(code); this.code = code; }
}
export function parseVisionResult(value: unknown): VisionResult {
  const root = exactRecord(value, ['outcome'], ['outcome', 'kind', 'facts', 'reason']);
  if (root.outcome === 'incomplete') {
    exactRecord(value, ['outcome', 'reason']);
    if (root.reason !== 'unreadable' && root.reason !== 'unsupported_surface') throw new VisionContractError('invalid_model_output');
    return {outcome: 'incomplete', reason: root.reason};
  }
  if (root.outcome !== 'observation') throw new VisionContractError('invalid_model_output');
  exactRecord(value, ['outcome', 'kind', 'facts']);
  if (root.kind === 'order_view') return {outcome: 'observation', kind: root.kind, facts: parseOrder(root.facts)};
  if (root.kind === 'email_draft') return {outcome: 'observation', kind: root.kind, facts: parseEmail(root.facts)};
  if (root.kind === 'ticket') return {outcome: 'observation', kind: root.kind, facts: parseTicket(root.facts)};
  throw new VisionContractError('invalid_model_output');
}

export type ScreenObservationParser = (value: unknown) => ScreenObservation;
export function createObservationFactory(parseObservation: ScreenObservationParser,
  createId: () => string = randomUUID): (result: VisionResult, context: VisionObservationContext<ScreenEvidenceRecord>) => ScreenObservation {
  return (result, context) => {
    if (result.outcome === 'incomplete') throw new VisionContractError('vision_incomplete');
    const expectedSurface = surfaceFor(result.kind);
    const sourceRevision = context.surface === expectedSurface ? context.sourceRevision : null;
    const entityRef = result.kind === 'email_draft' ? result.facts.recipientRef : result.facts.customerRef;
    return parseObservation({schemaVersion: 1, id: createId(), sessionId: context.sessionId,
      sequence: context.sequence, timestampMs: context.timestampMs, source: 'vision', frameId: context.frameId,
      sourceRevision, kind: result.kind, facts: result.facts, entityRef,
      evidenceIds: [context.evidence.id]});
  };
}
function surfaceFor(kind: Exclude<ScreenObservation['kind'], 'input_activity'>): VisionSurface {
  return kind === 'order_view' ? 'order' : kind === 'email_draft' ? 'email' : 'ticket';
}
function parseOrder(value: unknown): OrderFacts {
  const facts = exactRecord(value, ['customerRef', 'orderId', 'deliveryAddress', 'deliveryWindow']);
  return {customerRef: nullable(facts.customerRef), orderId: nullable(facts.orderId),
    deliveryAddress: nullable(facts.deliveryAddress), deliveryWindow: nullable(facts.deliveryWindow)};
}
function parseEmail(value: unknown): EmailDraftFacts {
  const facts = exactRecord(value, ['recipientRef', 'subject', 'bodyText', 'attachments', 'previewState']);
  if (typeof facts.subject !== 'string' || typeof facts.bodyText !== 'string' || !Array.isArray(facts.attachments) ||
    !['editing', 'preview', 'sent'].includes(String(facts.previewState))) throw new VisionContractError('invalid_model_output');
  const attachments = facts.attachments.map(value => {
    const item = exactRecord(value, ['kind'], ['kind', 'ocrText']);
    if (!['image', 'pdf', 'other'].includes(String(item.kind)) || ('ocrText' in item && typeof item.ocrText !== 'string')) {
      throw new VisionContractError('invalid_model_output');
    }
    return item.ocrText === undefined ? {kind: item.kind as 'image' | 'pdf' | 'other'} :
      {kind: item.kind as 'image' | 'pdf' | 'other', ocrText: item.ocrText as string};
  });
  return {recipientRef: nullable(facts.recipientRef), subject: facts.subject, bodyText: facts.bodyText,
    attachments, previewState: facts.previewState as EmailDraftFacts['previewState']};
}
function parseTicket(value: unknown): TicketFacts {
  const facts = exactRecord(value, ['ticketId', 'orderId', 'customerRef', 'status', 'summary']);
  if (typeof facts.ticketId !== 'string' || !facts.ticketId || !['open', 'done'].includes(String(facts.status)) ||
    typeof facts.summary !== 'string') throw new VisionContractError('invalid_model_output');
  return {ticketId: facts.ticketId, orderId: nullable(facts.orderId), customerRef: nullable(facts.customerRef),
    status: facts.status as TicketFacts['status'], summary: facts.summary};
}
function nullable(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) throw new VisionContractError('invalid_model_output');
  return value;
}
function exactRecord(value: unknown, required: readonly string[], allowed: readonly string[] = required): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VisionContractError('invalid_model_output');
  const record = value as Record<string, unknown>;
  if (required.some(key => !(key in record)) || Object.keys(record).some(key => !allowed.includes(key))) {
    throw new VisionContractError('invalid_model_output');
  }
  return record;
}
function nullableString(): Readonly<Record<string, unknown>> { return {type: ['string', 'null']}; }
