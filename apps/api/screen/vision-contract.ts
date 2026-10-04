import {randomUUID} from 'node:crypto';
import {SCREEN_ACTIVITY_LIMITS as LIMITS} from '@apprentice/contracts';
import type {EmailDraftFacts, OrderFacts, ScreenActivityFacts, ScreenObservation, ScreenRegion, TicketFacts} from '@apprentice/contracts';
import type {ScreenEvidenceRecord} from './evidence-store.ts';
import type {VisionObservationContext, VisionSurface} from '../../../packages/screen/vision/queue.ts';

export type VisionResult =
  | {readonly outcome: 'observation'; readonly kind: 'order_view'; readonly facts: OrderFacts}
  | {readonly outcome: 'observation'; readonly kind: 'email_draft'; readonly facts: EmailDraftFacts}
  | {readonly outcome: 'observation'; readonly kind: 'ticket'; readonly facts: TicketFacts}
  | {readonly outcome: 'observation'; readonly kind: 'screen_activity'; readonly facts: ScreenActivityFacts}
  | {readonly outcome: 'incomplete'; readonly reason: 'unreadable' | 'unsupported_surface'};

const WORKSPACE_BRANCHES: readonly unknown[] = Object.freeze([
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
]);
const INCOMPLETE_BRANCH = Object.freeze({type: 'object', required: ['outcome', 'reason'], additionalProperties: false,
  properties: {outcome: {const: 'incomplete'}, reason: {enum: ['unreadable', 'unsupported_surface']}}});
/** The workspace kinds only: a frame of a known workspace surface is read with this schema, exactly as before screen_activity. */
export const WORKSPACE_VISION_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#', oneOf: [...WORKSPACE_BRANCHES, INCOMPLETE_BRANCH],
});
// Generic vision of any app. Text lengths are clipped by the parser instead of a schema maxLength, which would
// cost a model retry; the arrays keep their limits here because a model counts items reliably.
const SCREEN_ACTIVITY_BRANCH = Object.freeze({type: 'object', required: ['outcome', 'kind', 'facts'], additionalProperties: false,
  properties: {outcome: {const: 'observation'}, kind: {const: 'screen_activity'}, facts: {type: 'object',
    required: ['app', 'surface', 'summary', 'change', 'entities', 'pendingAction', 'pendingRegionId', 'regions'], additionalProperties: false,
    properties: {app: {type: ['string', 'null'], description: 'app or site named by visible branding, else null'},
      surface: {type: 'string', minLength: 1, description: 'what is open'},
      summary: {type: 'string', minLength: 1, description: '1-2 sentences of what is visible'},
      change: {type: ['string', 'null'], description: 'visible sign of a change, else null'},
      entities: {type: 'array', maxItems: LIMITS.entities, items: {type: 'string'}, description: 'short visible items: names, amounts, cells, subjects'},
      pendingAction: {type: ['string', 'null'], description: 'control about to be used, else null'},
      pendingRegionId: {type: ['string', 'null'], description: 'id of that control\'s region in regions, else null'},
      regions: {type: 'array', maxItems: LIMITS.regions, items: {type: 'object', required: ['id', 'label', 'box'],
        additionalProperties: false, properties: {id: {type: 'string', description: 'unique: r1, r2, ...'}, label: {type: 'string'},
          box: {type: 'array', minItems: 4, maxItems: 4, items: {type: 'number', minimum: 0, maximum: 1},
            description: '[x, y, width, height], 0..1 of the processed frame; x + width <= 1 and y + height <= 1'}}}}}}}});
/** Every kind: a frame with no known surface (a shared screen of any app) is read with this schema. */
export const VISION_RESULT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#', oneOf: [...WORKSPACE_BRANCHES, SCREEN_ACTIVITY_BRANCH, INCOMPLETE_BRANCH],
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
  if (root.kind === 'screen_activity') return {outcome: 'observation', kind: root.kind, facts: parseScreenActivity(root.facts)};
  throw new VisionContractError('invalid_model_output');
}

export type ScreenObservationParser = (value: unknown) => ScreenObservation;
export function createObservationFactory(parseObservation: ScreenObservationParser,
  createId: () => string = randomUUID): (result: VisionResult, context: VisionObservationContext<ScreenEvidenceRecord>) => ScreenObservation {
  return (result, context) => {
    if (result.outcome === 'incomplete') throw new VisionContractError('vision_incomplete');
    if (result.kind === 'screen_activity') {
      // Only a frame with no known surface may be generic: a workspace frame must return its own kind.
      if (context.surface !== null) throw new VisionContractError('invalid_model_output');
      return parseObservation({schemaVersion: 1, id: createId(), sessionId: context.sessionId,
        sequence: context.sequence, timestampMs: context.timestampMs, source: 'vision', frameId: context.frameId,
        sourceRevision: null, kind: result.kind, facts: result.facts, entityRef: null,
        evidenceIds: [context.evidence.id]});
    }
    const expectedSurface = surfaceFor(result.kind);
    const sourceRevision = context.surface === expectedSurface ? context.sourceRevision : null;
    const entityRef = result.kind === 'email_draft' ? result.facts.recipientRef : result.facts.customerRef;
    return parseObservation({schemaVersion: 1, id: createId(), sessionId: context.sessionId,
      sequence: context.sequence, timestampMs: context.timestampMs, source: 'vision', frameId: context.frameId,
      sourceRevision, kind: result.kind, facts: result.facts, entityRef,
      evidenceIds: [context.evidence.id]});
  };
}
function surfaceFor(kind: Exclude<ScreenObservation['kind'], 'input_activity' | 'screen_activity'>): VisionSurface {
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
// Generic facts are normalised rather than rejected where that is safe: text is trimmed and clipped to the
// contract limits, empty optional text becomes null, repeated entities are dropped, region ids that are not plain
// or unique ids are renumbered, and a box that runs past the right or bottom edge is cut at the edge, so the
// canonical parser, which rejects such a box, never sees it. A wrong structure, a box value that is not a number
// in 0..1 or too many regions still rejects the frame.
function parseScreenActivity(value: unknown): ScreenActivityFacts {
  const facts = exactRecord(value, ['app', 'surface', 'summary', 'change', 'entities', 'pendingAction', 'pendingRegionId', 'regions']);
  const surface = clipText(facts.surface, LIMITS.surface); const summary = clipText(facts.summary, LIMITS.summary);
  if (!surface || !summary || !Array.isArray(facts.entities) || !Array.isArray(facts.regions) ||
    facts.regions.length > LIMITS.regions) throw new VisionContractError('invalid_model_output');
  const entities = [...new Set(facts.entities.map(entity => {
    if (typeof entity !== 'string') throw new VisionContractError('invalid_model_output');
    return clipText(entity, LIMITS.entity);
  }).filter((entity): entity is string => entity !== null))].slice(0, LIMITS.entities);
  // Model id (trimmed) -> kept id, for pendingRegionId; the first region with an id wins.
  const ids = new Map<string, string>(); const regions: ScreenRegion[] = [];
  for (const [index, raw] of facts.regions.entries()) {
    const item = exactRecord(raw, ['id', 'label', 'box']);
    const label = clipText(item.label, LIMITS.regionLabel);
    if (typeof item.id !== 'string' || !label) throw new VisionContractError('invalid_model_output');
    const taken = new Set(regions.map(region => region.id));
    const id = REGION_ID.test(item.id) && !taken.has(item.id) ? item.id : freeRegionId(index, taken);
    if (!ids.has(item.id.trim())) ids.set(item.id.trim(), id);
    regions.push({id, label, box: parseBox(item.box)});
  }
  const pending = facts.pendingRegionId;
  if (pending !== null && typeof pending !== 'string') throw new VisionContractError('invalid_model_output');
  return {app: optionalText(facts.app, LIMITS.app), surface, summary, change: optionalText(facts.change, LIMITS.change),
    entities, pendingAction: optionalText(facts.pendingAction, LIMITS.pendingAction),
    pendingRegionId: pending === null ? null : ids.get(pending.trim()) ?? null, regions};
}
const REGION_ID = new RegExp(`^[A-Za-z0-9._:-]{1,${LIMITS.regionId}}$`);
function freeRegionId(index: number, taken: ReadonlySet<string>): string {
  let n = index + 1;
  while (taken.has(`r${n}`)) n += 1;
  return `r${n}`;
}
/** [x, y, w, h] within 0..1; a box that runs past the frame edge is cut at the edge. */
function parseBox(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 ||
    !value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) throw new VisionContractError('invalid_model_output');
  const [x, y, w, h] = value as [number, number, number, number];
  return [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)];
}
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
/** Trimmed text clipped to max UTF-16 units (never half a surrogate pair), or null when empty. */
function clipText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') throw new VisionContractError('invalid_model_output');
  const text = value.replace(CONTROL, ' ').trim();
  if (!text) return null;
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}
function optionalText(value: unknown, max: number): string | null { return value === null ? null : clipText(value, max); }
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
