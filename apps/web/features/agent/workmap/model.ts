// The briefing board's view model: a pure function from what Review holds (the Work Map, the screen observations, the
// evidence list and the open follow-ups) to a storyboard. Keyframes are the vision observations at which something changed;
// each carries the change in words, the normalised facts the vision step reported, and the map items it is evidence for.
// No React here, so the ordering, the counts and the confirm rule are tested with plain node --test.
import type { ScreenEvidence, ScreenObservation } from '@apprentice/contracts';
import type { FactKey, MapGuardrail, MapStep, Question, WorkMap } from '@apprentice/agent';

export type { WorkMap, MapStep, MapGuardrail, Question } from '@apprentice/agent';

/** What resolveEvidence hands the board: a processed (masked) frame or clip, as a URL or a blob. */
export interface ResolvedEvidence {
  url?: string;
  blob?: Blob;
  startMs: number;
  endMs: number;
  kind: 'frame' | 'clip';
  /** True for generated placeholder media (sample sessions, demos). The board labels it "synthetic". */
  synthetic?: boolean;
}
export type ResolveEvidence = (evidenceId: string) => Promise<ResolvedEvidence | null>;

/** Same shape as packages/agent ConfirmIssue (reviewStatus(state).blockers can be passed as is). */
export interface BoardBlocker {
  kind: 'guardrail' | 'step';
  id: string;
  missing: ReadonlyArray<'evidence' | 'quote'>;
}

export interface BoardInput {
  map: WorkMap;
  observations: readonly ScreenObservation[];
  evidence?: readonly ScreenEvidence[];
  /** Open follow-ups (reviewStatus(state).openFollowUps). */
  gaps?: readonly Question[];
  blockers?: readonly BoardBlocker[];
}

export type Surface = 'order_view' | 'email_draft' | 'ticket';
export type ChangeKind =
  | 'order_opened'
  | 'email_started'
  | 'attachment_added'
  | 'attachment_removed'
  | 'body_text_added'
  | 'body_text_edited'
  | 'subject_changed'
  | 'recipient_changed'
  | 'preview_opened'
  | 'sent'
  | 'ticket_opened'
  | 'ticket_note'
  | 'ticket_done';

export interface ChangeEvent {
  kind: ChangeKind;
  label: string;
}

export interface FactRow {
  key: string;
  value: string;
}

export interface Keyframe {
  /** The observation id. */
  id: string;
  /** 1-based position in the storyboard. */
  index: number;
  atMs: number;
  surface: Surface;
  surfaceLabel: string;
  entityRef: string | null;
  /** The evidence shown as the thumbnail (a frame when there is one). */
  evidenceId: string | null;
  evidenceIds: string[];
  startMs: number;
  endMs: number;
  changes: ChangeEvent[];
  facts: FactRow[];
  stepIds: string[];
  guardrailIds: string[];
  gapIds: string[];
}

export type CardStatus = 'draft' | 'provisional' | 'confirmed' | 'conflicted';

export interface Moment {
  evidenceId: string;
  startMs: number;
  endMs: number;
}

interface CardBase {
  id: string;
  /** Keyframes this card is linked to, in time order. */
  frameIds: string[];
  evidenceIds: string[];
  /** The first linked screen moment, used for seek. */
  moment: Moment | null;
}

export interface StepCard extends CardBase {
  kind: 'step';
  number: number;
  judgment: boolean;
  goal: string;
  action: string;
  atMs: number;
  decision: string | null;
  reason: string | null;
  quote: string | null;
  quoteAtMs: number | null;
  status: CardStatus;
  statusNote: string;
  scope: string | null;
  requiredFields: Array<{ label: string; assumed: boolean }>;
  exceptions: string[];
  guardrailIds: string[];
  /** The validator's message when this card cannot be confirmed; null when it can (or has nothing to confirm). */
  blocker: string | null;
  confirmable: boolean;
}

export interface GuardrailCard extends CardBase {
  kind: 'guardrail';
  triggerLabel: string;
  condition: string;
  requiredAction: string;
  requiredFields: Array<{ label: string; assumed: boolean }>;
  scope: string;
  exceptions: string[];
  reason: string | null;
  reasonUnknown: boolean;
  unexplained: boolean;
  quote: string | null;
  quoteAtMs: number | null;
  escalateTo: string | null;
  duration: string | null;
  unknowns: string[];
  status: CardStatus;
  statusNote: string;
  blocker: string | null;
  confirmable: boolean;
}

export interface GapCard extends CardBase {
  kind: 'gap';
  topic: string;
  topicLabel: string;
  question: string;
  targetId: string | null;
  atMs: number | null;
  first: boolean;
}

export type BoardCard = StepCard | GuardrailCard | GapCard;

export interface BoardCounts {
  steps: number;
  judgmentCalls: number;
  guardrails: number;
  openGaps: number;
}

export interface PipelineCounts {
  frames: number;
  observations: number;
  changes: number;
  mapItems: number;
}

export interface Storyboard {
  keyframes: Keyframe[];
  steps: StepCard[];
  guardrails: GuardrailCard[];
  gaps: GapCard[];
  counts: BoardCounts;
  pipeline: PipelineCounts;
  version: number;
  mapStatus: WorkMap['status'];
  confirmed: boolean;
  confirmation: { quote: string | null; atMs: number } | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** mm:ss from milliseconds since sessionEpochMs. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const FIELD_LABELS: Readonly<Record<FactKey, string>> = {
  orderId: 'order number',
  deliveryAddress: 'delivery address',
  deliveryWindow: 'delivery window',
};

const SURFACE_LABELS: Readonly<Record<Surface, string>> = {
  order_view: 'Order',
  email_draft: 'Email draft',
  ticket: 'Ticket',
};

const TOPIC_LABELS: Readonly<Record<string, string>> = {
  reason: 'Why',
  essentials: 'What matters',
  guardrail: 'When to stop',
  scope: 'Who it applies to',
  exception: 'Exceptions',
  why_stop: 'Why stop',
  duration: 'How long it holds',
  ticket_note: 'Ticket note',
};

function listOf(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

function clip(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function factsInText(text: string, order: OrderLike | null): FactKey[] {
  if (order === null) return [];
  const body = ` ${norm(text)} `;
  const keys: FactKey[] = [];
  for (const key of ['orderId', 'deliveryAddress', 'deliveryWindow'] as const) {
    const value = order[key];
    if (value !== null && value.trim().length > 0 && body.includes(` ${norm(value)} `)) keys.push(key);
  }
  return keys;
}

interface OrderLike {
  orderId: string | null;
  deliveryAddress: string | null;
  deliveryWindow: string | null;
}

/** The validator's wording (packages/agent MapConfirmationError): "<kind> <id> lacks evidence and quote". */
export function blockerMessage(kind: 'step' | 'guardrail', id: string, missing: ReadonlyArray<'evidence' | 'quote'>): string {
  return `${kind} ${id} lacks ${missing.join(' and ')}`;
}

function missingOf(evidenceIds: readonly string[], quote: string | null): Array<'evidence' | 'quote'> {
  const missing: Array<'evidence' | 'quote'> = [];
  if (evidenceIds.length === 0) missing.push('evidence');
  if (quote === null || quote.trim().length === 0) missing.push('quote');
  return missing;
}

// ---------------------------------------------------------------------------
// Keyframes: the vision observations at which something changed
// ---------------------------------------------------------------------------

type VisionObservation = Exclude<ScreenObservation, { kind: 'input_activity' }>;

function factRows(obs: VisionObservation): FactRow[] {
  const rows: FactRow[] = [{ key: 'kind', value: obs.kind }];
  const add = (key: string, value: string | null): void => {
    rows.push({ key, value: value === null || value.length === 0 ? '—' : value });
  };
  if (obs.kind === 'order_view') {
    add('customerRef', obs.facts.customerRef);
    add('orderId', obs.facts.orderId);
    add('deliveryAddress', obs.facts.deliveryAddress);
    add('deliveryWindow', obs.facts.deliveryWindow);
  } else if (obs.kind === 'email_draft') {
    add('recipientRef', obs.facts.recipientRef);
    add('subject', clip(obs.facts.subject, 60));
    add('bodyText', obs.facts.bodyText.trim().length === 0 ? '(empty)' : clip(obs.facts.bodyText, 90));
    const attachments = obs.facts.attachments;
    add(
      'attachments',
      attachments.length === 0
        ? '[]'
        : attachments.map((a) => (a.ocrText ? `${a.kind} "${clip(a.ocrText, 40)}"` : a.kind)).join(', '),
    );
    add('previewState', obs.facts.previewState);
  } else {
    add('ticketId', obs.facts.ticketId);
    add('orderId', obs.facts.orderId);
    add('customerRef', obs.facts.customerRef);
    add('status', obs.facts.status);
    add('summary', obs.facts.summary.trim().length === 0 ? '(empty)' : clip(obs.facts.summary, 80));
  }
  return rows;
}

function changesOf(obs: VisionObservation, prev: VisionObservation | null, order: OrderLike | null): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  if (obs.kind === 'order_view') {
    const p = prev?.kind === 'order_view' ? prev.facts : null;
    if (p === null || p.orderId !== obs.facts.orderId || p.customerRef !== obs.facts.customerRef) {
      const who = obs.facts.customerRef ?? 'an unrecognised customer';
      out.push({ kind: 'order_opened', label: `Order ${obs.facts.orderId ?? '(no number)'} opened for ${who}` });
    }
    return out;
  }
  if (obs.kind === 'ticket') {
    const p = prev?.kind === 'ticket' ? prev.facts : null;
    if (p === null || p.ticketId !== obs.facts.ticketId) out.push({ kind: 'ticket_opened', label: `Ticket ${obs.facts.ticketId} opened` });
    if (p !== null && p.summary !== obs.facts.summary && obs.facts.summary.trim().length > 0) {
      out.push({ kind: 'ticket_note', label: 'Note written on the ticket' });
    }
    if (obs.facts.status === 'done' && p?.status !== 'done') out.push({ kind: 'ticket_done', label: 'Ticket marked done' });
    return out;
  }
  const e = obs.facts;
  const p = prev?.kind === 'email_draft' ? prev.facts : null;
  if (p === null) {
    out.push({ kind: 'email_started', label: e.recipientRef ? `Email draft started to ${e.recipientRef}` : 'Email draft started' });
  } else {
    if (p.recipientRef !== e.recipientRef) out.push({ kind: 'recipient_changed', label: `Recipient changed to ${e.recipientRef ?? 'nobody'}` });
    if (p.subject !== e.subject) out.push({ kind: 'subject_changed', label: 'Subject changed' });
  }
  const before = p?.attachments ?? [];
  if (e.attachments.length > before.length) {
    const kind = e.attachments[e.attachments.length - 1]?.kind ?? 'other';
    out.push({ kind: 'attachment_added', label: `${capitalize(kind)} attachment added` });
  } else if (e.attachments.length < before.length) {
    const kind = before[before.length - 1]?.kind ?? 'other';
    out.push({ kind: 'attachment_removed', label: `${capitalize(kind)} attachment removed` });
  }
  const prevBody = p?.bodyText ?? '';
  if (e.bodyText.trim() !== prevBody.trim() && e.bodyText.trim().length > 0) {
    const now = factsInText(e.bodyText, order);
    const had = factsInText(prevBody, order);
    const fresh = now.filter((k) => !had.includes(k)).map((k) => FIELD_LABELS[k]);
    if (fresh.length > 0) out.push({ kind: 'body_text_added', label: `${capitalize(listOf(fresh))} typed into the email` });
    else if (prevBody.trim().length === 0) out.push({ kind: 'body_text_added', label: 'Text typed into the email' });
    else out.push({ kind: 'body_text_edited', label: 'Email text edited' });
  }
  if (p !== null && p.previewState !== e.previewState) {
    if (e.previewState === 'preview') out.push({ kind: 'preview_opened', label: 'Preview opened before Send' });
    if (e.previewState === 'sent') out.push({ kind: 'sent', label: 'Email sent' });
  }
  return out;
}

function frameEvidenceOf(ids: readonly string[], evidence: ReadonlyMap<string, ScreenEvidence>): string | null {
  for (const id of ids) if (evidence.get(id)?.kind === 'frame') return id;
  return ids[0] ?? null;
}

export function buildKeyframes(
  observations: readonly ScreenObservation[],
  evidenceList: readonly ScreenEvidence[] = [],
): Keyframe[] {
  const evidence = new Map(evidenceList.map((e) => [e.id, e]));
  const vision = observations
    .filter((o): o is VisionObservation => o.kind !== 'input_activity')
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs || a.sequence - b.sequence);
  const prevBySurface = new Map<Surface, VisionObservation>();
  let order: OrderLike | null = null;
  const frames: Keyframe[] = [];
  for (const obs of vision) {
    if (obs.kind === 'order_view') order = obs.facts;
    const changes = changesOf(obs, prevBySurface.get(obs.kind) ?? null, order);
    prevBySurface.set(obs.kind, obs);
    if (changes.length === 0) continue;
    const evidenceId = frameEvidenceOf(obs.evidenceIds, evidence);
    const ev = evidenceId === null ? undefined : evidence.get(evidenceId);
    frames.push({
      id: obs.id,
      index: frames.length + 1,
      atMs: obs.timestampMs,
      surface: obs.kind,
      surfaceLabel: SURFACE_LABELS[obs.kind],
      entityRef: obs.entityRef,
      evidenceId,
      evidenceIds: [...obs.evidenceIds],
      startMs: ev?.startMs ?? obs.timestampMs,
      endMs: ev?.endMs ?? obs.timestampMs + 1000,
      changes,
      facts: factRows(obs),
      stepIds: [],
      guardrailIds: [],
      gapIds: [],
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function framesFor(evidenceIds: readonly string[], frames: readonly Keyframe[]): Keyframe[] {
  return frames.filter((f) => f.evidenceIds.some((id) => evidenceIds.includes(id)));
}

function momentOf(evidenceIds: readonly string[], frames: readonly Keyframe[], evidence: ReadonlyMap<string, ScreenEvidence>): Moment | null {
  const linked = framesFor(evidenceIds, frames)[0];
  if (linked?.evidenceId) return { evidenceId: linked.evidenceId, startMs: linked.startMs, endMs: linked.endMs };
  const id = frameEvidenceOf(evidenceIds, evidence);
  if (id === null) return null;
  const ev = evidence.get(id);
  return ev ? { evidenceId: id, startMs: ev.startMs, endMs: ev.endMs } : { evidenceId: id, startMs: 0, endMs: 0 };
}

function scopeText(g: MapGuardrail): string {
  if (g.scope.kind === 'all') return 'Every customer';
  const who = listOf(g.scope.customers) || 'this customer';
  return g.scope.explicit ? `Only ${who}` : `Only ${who} (assumed from the screen)`;
}

function fieldsOf(g: MapGuardrail): Array<{ label: string; assumed: boolean }> {
  return g.requiredFacts.map((k) => ({ label: FIELD_LABELS[k], assumed: g.assumedFacts.includes(k) }));
}

function stepStatus(s: MapStep): { status: CardStatus; note: string } {
  if (s.status === 'confirmed') return { status: 'confirmed', note: 'Confirmed in the teach-back' };
  if (s.status === 'inferred') return { status: 'provisional', note: "From the expert's answer, not confirmed yet" };
  return { status: 'draft', note: 'Seen on screen only' };
}

function guardrailStatus(g: MapGuardrail): { status: CardStatus; note: string } {
  if (g.unexplained) return { status: 'draft', note: 'Reason unknown: kept as a habit, never enforced' };
  if (g.status === 'confirmed') return { status: 'confirmed', note: 'Confirmed in the teach-back' };
  if (g.status === 'conflicted') return { status: 'conflicted', note: 'Answers conflict: needs the expert' };
  return { status: 'provisional', note: "From the expert's answer, not confirmed yet" };
}

const TRIGGER_LABELS: Readonly<Record<MapGuardrail['trigger'], string>> = {
  customer: 'Customer rule',
  unknown_entity: 'Stop and ask',
  stop_condition: 'Stop condition',
};

/** Build the whole storyboard. Pure: the same input gives the same board. */
export function buildStoryboard(input: BoardInput): Storyboard {
  const { map } = input;
  const evidenceList = input.evidence ?? [];
  const evidence = new Map(evidenceList.map((e) => [e.id, e]));
  const keyframes = buildKeyframes(input.observations, evidenceList);
  const given = new Map((input.blockers ?? []).map((b) => [`${b.kind}:${b.id}`, b.missing]));
  const guardrailById = new Map(map.guardrails.map((g) => [g.id, g]));

  const steps: StepCard[] = map.steps
    .slice()
    .sort((a, b) => a.atMs - b.atMs)
    .map((s, i) => {
      const linked = s.guardrailIds.map((id) => guardrailById.get(id)).filter((g): g is MapGuardrail => g !== undefined);
      const rule = linked.find((g) => g.trigger === 'customer') ?? linked[0] ?? null;
      const quote = s.decision?.quote ?? null;
      const quoteAtMs =
        quote === null
          ? null
          : (linked.find((g) => g.quote === quote)?.quoteAtMs ??
            map.answered.find((a) => a.evidenceIds.some((id) => (s.decision?.evidenceIds ?? []).includes(id)))?.atMs ??
            null);
      const evidenceIds = [...new Set([...s.evidenceIds, ...(s.decision?.evidenceIds ?? [])])];
      let missing = given.get(`step:${s.id}`) ?? null;
      if (missing === null && s.decision !== null) {
        const m = missingOf(s.decision.evidenceIds, s.decision.quote);
        missing = m.length > 0 ? m : null;
      }
      const { status, note } = stepStatus(s);
      return {
        kind: 'step' as const,
        id: s.id,
        number: i + 1,
        judgment: s.kind === 'judgment',
        goal: s.goal,
        action: s.action,
        atMs: s.atMs,
        decision: s.decision?.summary ?? null,
        reason: s.decision?.reason ?? null,
        quote,
        quoteAtMs,
        status,
        statusNote: note,
        scope: rule && rule.trigger === 'customer' ? scopeText(rule) : null,
        requiredFields: rule ? fieldsOf(rule) : [],
        exceptions: rule ? rule.exceptions.map((e) => e.text) : [],
        guardrailIds: [...s.guardrailIds],
        blocker: missing ? blockerMessage('step', s.id, missing) : null,
        confirmable: s.decision !== null && missing === null,
        frameIds: framesFor(evidenceIds, keyframes).map((f) => f.id),
        evidenceIds,
        moment: momentOf(evidenceIds, keyframes, evidence),
      };
    });

  const guardrails: GuardrailCard[] = map.guardrails.map((g) => {
    let missing = given.get(`guardrail:${g.id}`) ?? null;
    if (missing === null) {
      const m = missingOf(g.evidenceIds, g.quote);
      missing = m.length > 0 ? m : null;
    }
    const { status, note } = guardrailStatus(g);
    return {
      kind: 'guardrail' as const,
      id: g.id,
      triggerLabel: TRIGGER_LABELS[g.trigger],
      condition: g.condition,
      requiredAction: g.requiredAction,
      requiredFields: fieldsOf(g),
      scope: scopeText(g),
      exceptions: g.exceptions.map((e) => e.text),
      reason: g.reason,
      reasonUnknown: g.reason === null,
      unexplained: g.unexplained,
      quote: g.quote,
      quoteAtMs: g.quoteAtMs,
      escalateTo: g.escalateTo,
      duration: g.duration,
      unknowns: [...g.unknowns],
      status,
      statusNote: note,
      blocker: missing ? blockerMessage('guardrail', g.id, missing) : null,
      confirmable: missing === null && !g.unexplained && g.status !== 'conflicted',
      frameIds: framesFor(g.evidenceIds, keyframes).map((f) => f.id),
      evidenceIds: [...g.evidenceIds],
      moment: momentOf(g.evidenceIds, keyframes, evidence),
    };
  });

  const gaps: GapCard[] = (input.gaps ?? []).map((q, i) => {
    const frames = framesFor(q.evidenceIds, keyframes);
    return {
      kind: 'gap' as const,
      id: q.id,
      topic: q.topic,
      topicLabel: TOPIC_LABELS[q.topic] ?? q.topic,
      question: q.text,
      targetId: q.targetId,
      atMs: frames[0]?.atMs ?? null,
      first: i === 0,
      frameIds: frames.map((f) => f.id),
      evidenceIds: [...q.evidenceIds],
      moment: momentOf(q.evidenceIds, keyframes, evidence),
    };
  });

  for (const f of keyframes) {
    f.stepIds = steps.filter((c) => c.frameIds.includes(f.id)).map((c) => c.id);
    f.guardrailIds = guardrails.filter((c) => c.frameIds.includes(f.id)).map((c) => c.id);
    f.gapIds = gaps.filter((c) => c.frameIds.includes(f.id)).map((c) => c.id);
  }

  return {
    keyframes,
    steps,
    guardrails,
    gaps,
    counts: {
      steps: steps.length,
      judgmentCalls: steps.filter((s) => s.judgment).length,
      guardrails: guardrails.length,
      openGaps: gaps.length,
    },
    pipeline: {
      frames: evidenceList.filter((e) => e.kind === 'frame').length,
      observations: input.observations.filter((o) => o.kind !== 'input_activity').length,
      changes: keyframes.reduce((n, f) => n + f.changes.length, 0),
      mapItems: steps.length + guardrails.length,
    },
    version: map.version,
    mapStatus: map.status,
    confirmed: map.confirmed,
    confirmation: map.confirmation ? { quote: map.confirmation.quote, atMs: map.confirmation.atMs } : null,
  };
}

/** Every card on the board, for lookups by key ("step:step-4", "guardrail:g1", "gap:q-R-1"). */
export function cardKey(card: Pick<BoardCard, 'kind' | 'id'>): string {
  return `${card.kind}:${card.id}`;
}
