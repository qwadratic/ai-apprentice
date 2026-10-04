import { SCREEN_ACTIVITY_LIMITS as LIMITS } from './types.ts';
import type { ActionCheckpoint, CheckpointReply, ScreenEvidence, ScreenObservation, ScreenStatus, SessionStart } from './types.ts';
export class ContractValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ContractValidationError'; }
}
function fail(path: string): never { throw new ContractValidationError(`Invalid ${path}`); }
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const key of required) if (!(key in value)) fail(key);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) fail(`unexpected field ${key}`);
}
function string(value: unknown, path: string, nonempty = false): void {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(path);
}
function nullableString(value: unknown, path: string): void { if (value !== null) string(value, path, true); }
function integer(value: unknown, path: string, min = 0): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail(path);
}
function choice(value: unknown, values: unknown[], path: string): void { if (!values.includes(value)) fail(path); }
function ids(value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path);
  value.forEach((id) => string(id, path, true));
  if (new Set(value).size !== value.length) fail(`${path} duplicates`);
}
function version(value: Record<string, unknown>): void { choice(value.schemaVersion, [1], 'schemaVersion'); }
// Control characters other than tab and line breaks; the conductor drops such strings.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const REGION_ID = /^[A-Za-z0-9._:-]+$/;
function text(value: unknown, path: string, max: number, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) fail(path);
}
function box(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) fail(path);
  const [x, y, w, h] = value as number[];
  // A small tolerance for float sums, the same as the conductor's.
  if ((x as number) + (w as number) > 1.0001 || (y as number) + (h as number) > 1.0001) fail(path);
}
function screenActivity(f: Record<string, unknown>): void {
  keys(f, ['app', 'surface', 'summary', 'change', 'entities', 'pendingAction', 'pendingRegionId', 'regions']);
  text(f.app, 'app', LIMITS.app, true); text(f.surface, 'surface', LIMITS.surface); text(f.summary, 'summary', LIMITS.summary);
  text(f.change, 'change', LIMITS.change, true); text(f.pendingAction, 'pendingAction', LIMITS.pendingAction, true);
  if (!Array.isArray(f.entities) || f.entities.length > LIMITS.entities) fail('entities');
  for (const entity of f.entities) text(entity, 'entity', LIMITS.entity);
  if (!Array.isArray(f.regions) || f.regions.length > LIMITS.regions) fail('regions');
  const regionIds = new Set<string>();
  for (const region of f.regions) {
    const r = record(region, 'region'); keys(r, ['id', 'label', 'box']);
    text(r.id, 'region.id', LIMITS.regionId);
    if (!REGION_ID.test(r.id as string) || regionIds.has(r.id as string)) fail('region.id');
    regionIds.add(r.id as string); text(r.label, 'region.label', LIMITS.regionLabel); box(r.box, 'region.box');
  }
  if (f.pendingRegionId !== null && !regionIds.has(f.pendingRegionId as string)) fail('pendingRegionId');
}
function revisions(value: unknown, path: string): void {
  const v = record(value, path); keys(v, ['order', 'email']);
  string(v.order, `${path}.order`, true); string(v.email, `${path}.email`, true);
}
export function parseSessionStart(value: unknown): SessionStart {
  const v = record(value, 'session'); keys(v, ['sessionId', 'sessionEpochMs']);
  string(v.sessionId, 'sessionId', true); integer(v.sessionEpochMs, 'sessionEpochMs');
  return structuredClone(v) as unknown as SessionStart;
}
export function parseScreenObservation(value: unknown): ScreenObservation {
  const v = record(value, 'observation');
  keys(v, ['schemaVersion', 'id', 'sessionId', 'sequence', 'timestampMs', 'source', 'frameId', 'sourceRevision', 'kind', 'facts', 'entityRef', 'evidenceIds']);
  version(v); string(v.id, 'id', true); string(v.sessionId, 'sessionId', true);
  integer(v.sequence, 'sequence', 1); integer(v.timestampMs, 'timestampMs');
  choice(v.source, ['vision', 'workspace'], 'source'); nullableString(v.frameId, 'frameId');
  nullableString(v.sourceRevision, 'sourceRevision'); nullableString(v.entityRef, 'entityRef'); ids(v.evidenceIds, 'evidenceIds');
  const f = record(v.facts, 'facts');
  switch (v.kind) {
    case 'order_view':
      keys(f, ['customerRef', 'orderId', 'deliveryAddress', 'deliveryWindow']);
      nullableString(f.customerRef, 'customerRef'); nullableString(f.orderId, 'orderId');
      nullableString(f.deliveryAddress, 'deliveryAddress'); nullableString(f.deliveryWindow, 'deliveryWindow');
      if (v.entityRef !== f.customerRef) fail('entityRef/customerRef mismatch');
      break;
    case 'email_draft':
      keys(f, ['recipientRef', 'subject', 'bodyText', 'attachments', 'previewState']);
      nullableString(f.recipientRef, 'recipientRef'); string(f.subject, 'subject'); string(f.bodyText, 'bodyText');
      choice(f.previewState, ['editing', 'preview', 'sent'], 'previewState');
      if (!Array.isArray(f.attachments)) fail('attachments');
      for (const attachment of f.attachments) {
        const a = record(attachment, 'attachment'); keys(a, ['kind'], ['ocrText']);
        choice(a.kind, ['image', 'pdf', 'other'], 'attachment.kind');
        if ('ocrText' in a) string(a.ocrText, 'ocrText');
      }
      break;
    case 'ticket':
      keys(f, ['customerRef', 'ticketId', 'orderId', 'status', 'summary']);
      nullableString(f.customerRef, 'customerRef'); string(f.ticketId, 'ticketId', true);
      nullableString(f.orderId, 'orderId'); choice(f.status, ['open', 'done'], 'ticket.status'); string(f.summary, 'summary');
      if (v.entityRef !== f.customerRef) fail('entityRef/customerRef mismatch');
      break;
    case 'input_activity':
      keys(f, ['surface', 'typing', 'idleMs', 'lastInputAtMs']); choice(f.surface, ['order', 'email', 'ticket'], 'surface');
      if (typeof f.typing !== 'boolean') fail('typing'); integer(f.idleMs, 'idleMs'); integer(f.lastInputAtMs, 'lastInputAtMs');
      if (f.idleMs !== (v.timestampMs as number) - (f.lastInputAtMs as number)) fail('idleMs/lastInputAtMs mismatch');
      if (v.source !== 'workspace' || v.frameId !== null || v.sourceRevision !== null || v.entityRef !== null || (v.evidenceIds as string[]).length) fail('input_activity workspace provenance');
      break;
    case 'screen_activity':
      screenActivity(f);
      // Generic vision never names an entity and carries no workspace revision.
      if (v.entityRef !== null || v.sourceRevision !== null) fail('screen_activity entityRef/sourceRevision');
      break;
    default: fail('kind');
  }
  if (v.kind !== 'input_activity' && (v.source !== 'vision' || v.frameId === null || !(v.evidenceIds as string[]).length)) fail('visual observation provenance');
  return structuredClone(v) as unknown as ScreenObservation;
}
export function parseScreenStatus(value: unknown): ScreenStatus {
  const v = record(value, 'status'); keys(v, ['schemaVersion', 'sessionId', 'state'], ['reason']); version(v);
  string(v.sessionId, 'sessionId', true); choice(v.state, ['capturing', 'paused', 'stopped', 'error'], 'state');
  if ('reason' in v) string(v.reason, 'reason'); return structuredClone(v) as unknown as ScreenStatus;
}
export function parseScreenEvidence(value: unknown): ScreenEvidence {
  const v = record(value, 'evidence'); keys(v, ['schemaVersion', 'id', 'kind', 'assetRef', 'startMs', 'endMs']); version(v);
  string(v.id, 'id', true); choice(v.kind, ['frame', 'clip'], 'kind'); string(v.assetRef, 'assetRef', true);
  integer(v.startMs, 'startMs'); integer(v.endMs, 'endMs');
  if ((v.endMs as number) < (v.startMs as number)) fail('evidence interval');
  return structuredClone(v) as unknown as ScreenEvidence;
}
export function parseActionCheckpoint(value: unknown): ActionCheckpoint {
  const v = record(value, 'checkpoint'); keys(v, ['schemaVersion', 'id', 'sessionId', 'timestampMs', 'observationIds', 'revisions', 'action']); version(v);
  string(v.id, 'id', true); string(v.sessionId, 'sessionId', true); integer(v.timestampMs, 'timestampMs');
  ids(v.observationIds, 'observationIds'); revisions(v.revisions, 'revisions'); choice(v.action, ['send'], 'action');
  return structuredClone(v) as unknown as ActionCheckpoint;
}
export function parseCheckpointReply(value: unknown): CheckpointReply {
  const v = record(value, 'reply'); keys(v, ['schemaVersion', 'checkpointId', 'status', 'message', 'evidenceIds', 'basedOn']); version(v);
  string(v.checkpointId, 'checkpointId', true); choice(v.status, ['clear', 'warn', 'unknown'], 'reply.status');
  string(v.message, 'message', true); ids(v.evidenceIds, 'evidenceIds'); revisions(v.basedOn, 'basedOn');
  return structuredClone(v) as unknown as CheckpointReply;
}
/** Structural validity alone cannot authorise Send. Compare the current workspace state too. */
export function assertCurrentCheckpoint(value: unknown, sessionId: string, observations: readonly ScreenObservation[]): ActionCheckpoint {
  const c = parseActionCheckpoint(value);
  if (c.sessionId !== sessionId) fail('checkpoint session');
  const current = observations.filter((o) => o.sessionId === sessionId);
  const latest = (kind: ScreenObservation['kind']) => current.filter((o) => o.kind === kind).at(-1);
  const order = latest('order_view'); const email = latest('email_draft');
  if (!order || !email || email.kind !== 'email_draft' || email.facts.previewState !== 'preview') fail('checkpoint requires order and preview email');
  if (!c.observationIds.includes(order.id) || !c.observationIds.includes(email.id)) fail('checkpoint stale observations');
  if (c.observationIds.some((id) => !current.some((o) => o.id === id))) fail('checkpoint unknown observation');
  if (order.sourceRevision === null || email.sourceRevision === null) fail('checkpoint requires tracked source revisions');
  if (c.revisions.order !== order.sourceRevision || c.revisions.email !== email.sourceRevision) fail('checkpoint revision mismatch');
  if (c.timestampMs < Math.max(order.timestampMs, email.timestampMs)) fail('checkpoint precedes capture');
  return c;
}
