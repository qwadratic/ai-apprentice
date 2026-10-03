// ScreenBridge v1 DRAFT (TASK-1 / TASK-3.1).
//
// This is stream B's proposal of the only interface between stream A (screen,
// workspace) and stream B (agent, voice, knowledge). Stream A writes the real
// implementation in packages/contracts; until then B develops against this file
// and the fakes in ./fake. A change to any type here goes through a small PR
// that both owners approve. Never extend the facts schema silently.
//
// Rules of the contract:
// - every timestampMs counts from the single sessionEpochMs passed to start() and is
//   a wall-clock offset (now - sessionEpochMs): paused time is a gap, not removed;
// - screen facts describe only what is visible; reasons and rules are the
//   agent's job, never an observation's;
// - an unrecognised entity is entityRef = null, not a guess;
// - input_activity is a heartbeat emitted by OUR demo workspace (screen capture
//   cannot see keystrokes in other apps); it exists so the agent can stay quiet
//   while the expert types. Its envelope has source "workspace" and frameId null;
//   everything else is source "vision" with a real processed frame;
// - input_activity idle time: idleMs = timestampMs - lastInputAtMs, always. No heartbeat
//   before the first input of a session; one right on input, then at most every 2 s; the
//   first typing:false heartbeat comes about 2000 ms after the last input with its real
//   idle time; idle heartbeats every 2 s stop after the first one at or after 10000 ms;
// - an ActionCheckpoint carries observationIds and opaque revisions only, no facts;
// - start() ends paused with reason "mask-review" and resume() can be refused
//   (mask review, geometry change, muted source); both resolve to {state, reason}
//   and a refused resume is a normal result, not an error.

import {
  arrayOf,
  bool,
  finish,
  num,
  nullableStr,
  object,
  oneOf,
  optionalStr,
  str,
  strArray,
} from "./validation.ts";
import type { ValidationResult } from "./validation.ts";

export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Facts schema
// ---------------------------------------------------------------------------

/**
 * Order table / order card. customerRef is a stable synthetic id such as "customer_07".
 * Every field is null when unreadable, masked or not recognised: unknown stays null, never guessed.
 */
export interface OrderFacts {
  customerRef: string | null;
  orderId: string | null;
  deliveryAddress: string | null;
  deliveryWindow: string | null;
}

export const ATTACHMENT_KINDS = ["image", "pdf", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface EmailAttachment {
  kind: AttachmentKind;
  /** Text recognised inside the attachment, when the vision step could read it. */
  ocrText?: string;
}

export const PREVIEW_STATES = ["editing", "preview", "sent"] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

export interface EmailDraftFacts {
  /** Stable synthetic id of the recipient, or null when not recognised. */
  recipientRef: string | null;
  subject: string;
  bodyText: string;
  attachments: EmailAttachment[];
  previewState: PreviewState;
}

export const TICKET_STATUSES = ["open", "done"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface TicketFacts {
  ticketId: string;
  orderId: string | null;
  customerRef: string | null;
  status: TicketStatus;
  /** The work summary the person wrote about the finished work (may be visibly empty). */
  summary: string;
}

export const WORKSPACE_SURFACES = ["order", "email", "ticket"] as const;
export type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number];

/** Heartbeat from the demo workspace, not from vision. */
export interface InputActivityFacts {
  surface: WorkspaceSurface;
  typing: boolean;
  /**
   * Milliseconds since the last input event in the workspace. Always
   * observation.timestampMs - lastInputAtMs (the validator enforces it within 1 ms):
   * it is not reset to zero when typing stops.
   */
  idleMs: number;
  /** Session-relative timestamp (ms since sessionEpochMs) of the last actual input; never after timestampMs. */
  lastInputAtMs: number;
}

export const OBSERVATION_KINDS = ["order_view", "email_draft", "ticket", "input_activity"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export const OBSERVATION_SOURCES = ["vision", "workspace"] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

interface ObservationBase {
  schemaVersion: SchemaVersion;
  id: string;
  sessionId: string;
  /** Strictly increasing per session, starting at 1. */
  sequence: number;
  /** Milliseconds since sessionEpochMs (wall-clock offset, includes paused gaps). */
  timestampMs: number;
  /** "workspace" only for input_activity (our own DOM events); everything else is "vision". */
  source: ObservationSource;
  /** Processed frame the facts were read from; null only when source is "workspace". */
  frameId: string | null;
  /**
   * Opaque workspace revision at frame capture, attached by A's provenance adapter (the
   * model cannot assert it). null for workspace heartbeats and for any screen that is not
   * our demo workspace: such observations are history only, never checkpoint input.
   */
  sourceRevision: string | null;
  entityRef: string | null;
  /** Evidence that shows this observation; empty for workspace heartbeats. */
  evidenceIds: string[];
}

export type ScreenObservation =
  | (ObservationBase & { kind: "order_view"; facts: OrderFacts })
  | (ObservationBase & { kind: "email_draft"; facts: EmailDraftFacts })
  | (ObservationBase & { kind: "ticket"; facts: TicketFacts })
  | (ObservationBase & { kind: "input_activity"; facts: InputActivityFacts });

export const SCREEN_STATES = ["capturing", "paused", "stopped", "error"] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

/**
 * Why the screen is in its state. Mirrors A's capture reasons plus "off_record",
 * which describes the user's own off-the-record action (never permission loss or mask editing).
 */
export const SCREEN_STATUS_REASONS = [
  "mask-review",
  "geometry-changed",
  "user-paused",
  "off_record",
  "source-ended",
  "source-muted",
  "permission-denied",
  "capture-failed",
  "unsupported",
  "frame-failed",
  "consumer-failed",
  "stopped",
] as const;
export type ScreenStatusReason = (typeof SCREEN_STATUS_REASONS)[number];

export interface ScreenStatus {
  schemaVersion: SchemaVersion;
  sessionId: string;
  state: ScreenState;
  reason?: ScreenStatusReason;
}

/** Reasons a caller may give to pause(). */
export const PAUSE_REASONS = ["off_record", "user-paused"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const EVIDENCE_KINDS = ["frame", "clip"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ScreenEvidence {
  schemaVersion: SchemaVersion;
  id: string;
  kind: EvidenceKind;
  /** Opaque reference the replay panel can load (processed, masked media only). */
  assetRef: string;
  startMs: number;
  endMs: number;
}

/** What resolveEvidence returns. */
export interface EvidenceRef {
  assetRef: string;
  startMs: number;
  endMs: number;
}

/** Opaque workspace versions of the order and the email draft; they change on every edit and never carry content. */
export interface WorkspaceRevisions {
  order: string;
  email: string;
}

/**
 * Raised by the demo workspace on Preview (and before Send).
 * observationIds MUST include the latest order observation and the latest
 * email-draft observation the workspace has produced so far (evidence links, replay).
 * revisions are opaque identity/version tokens, never content. The checkpoint carries NO
 * order or email facts: the agent reads them from the referenced vision observations (see
 * factsFromCheckpoint), because reading the workspace snapshot would bypass the vision
 * route and the privacy masks (doc-7, section 3, agreed by both streams).
 */
export interface ActionCheckpoint {
  schemaVersion: SchemaVersion;
  id: string;
  sessionId: string;
  timestampMs: number;
  observationIds: string[];
  revisions: WorkspaceRevisions;
  action: "send";
}

export const CHECKPOINT_STATUSES = ["clear", "warn", "unknown"] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

/** The agent's answer to a checkpoint. The decision to send stays with the human. */
export interface CheckpointReply {
  schemaVersion: SchemaVersion;
  checkpointId: string;
  status: CheckpointStatus;
  /** Action, reason and source in plain words. */
  message: string;
  evidenceIds: string[];
  /** The revisions this reply judged. The workspace applies it only if both are still current. */
  basedOn: WorkspaceRevisions;
}

export type Unsubscribe = () => void;

/**
 * Lifecycle methods return Promise<void>. onStatus is authoritative: a resolved call does
 * not mean the screen is capturing. Mask review, a refused resume and the off-the-record
 * pause arrive only as a ScreenStatus (state "paused" with a reason); a refusal is not an error.
 */
export interface ScreenBridge {
  /**
   * Begin a session. All timestampMs are relative to sessionEpochMs (epoch ms). Status goes
   * to "paused" with reason "mask-review"; capturing begins only once the masks are confirmed.
   */
  start(opts: { sessionId: string; sessionEpochMs: number }): Promise<void>;
  /**
   * Stop emitting observations and capturing. Anything not yet emitted must never be emitted.
   * Resolves after output is closed; status then carries `reason` (default "user-paused";
   * the off-the-record button passes "off_record"). Pausing while already paused never
   * downgrades "off_record": it stays until resume() or stop().
   */
  pause(reason?: PauseReason): Promise<void>;
  /**
   * Continue after pause(). Observations that would have occurred while paused are dropped,
   * never replayed. Can be refused (mask review, geometry change, muted source): the call
   * still resolves and status reports paused with the reason.
   */
  resume(): Promise<void>;
  /**
   * Confirms the privacy masks after start() or a mask edit; capturing resumes only if the
   * pause reason is "mask-review". It never lifts an off-the-record pause. Optional because
   * the real bridge confirms through A's mask-review UI.
   */
  confirmMasks?(): Promise<void>;
  stop(): Promise<void>;
  resolveEvidence(evidenceId: string): Promise<EvidenceRef>;

  onObservation(listener: (obs: ScreenObservation) => void): Unsubscribe;
  onStatus(listener: (status: ScreenStatus) => void): Unsubscribe;
  /** Sandbox -> agent. */
  onCheckpoint(listener: (checkpoint: ActionCheckpoint) => void): Unsubscribe;
  /** Agent -> sandbox: the answer to a checkpoint. */
  replyToCheckpoint(reply: CheckpointReply): Promise<void>;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function checkSchemaVersion(o: Record<string, unknown>, path: string, errors: string[]): void {
  if (o.schemaVersion !== SCHEMA_VERSION) errors.push(`${path}.schemaVersion: expected ${SCHEMA_VERSION}`);
}

export function validateOrderFacts(value: unknown, path = "facts"): ValidationResult<OrderFacts> {
  const errors: string[] = [];
  checkOrderFacts(value, path, errors);
  return finish(value, errors);
}

function checkOrderFacts(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    nullableStr(o.customerRef, `${path}.customerRef`, errors);
    nullableStr(o.orderId, `${path}.orderId`, errors);
    nullableStr(o.deliveryAddress, `${path}.deliveryAddress`, errors);
    nullableStr(o.deliveryWindow, `${path}.deliveryWindow`, errors);
  });
}

function checkEmailFacts(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    nullableStr(o.recipientRef, `${path}.recipientRef`, errors);
    str(o.subject, `${path}.subject`, errors, { allowEmpty: true });
    str(o.bodyText, `${path}.bodyText`, errors, { allowEmpty: true });
    arrayOf(o.attachments, `${path}.attachments`, errors, (a, p, e) =>
      object(a, p, e, (att) => {
        oneOf(att.kind, ATTACHMENT_KINDS, `${p}.kind`, e);
        optionalStr(att.ocrText, `${p}.ocrText`, e);
      }),
    );
    oneOf(o.previewState, PREVIEW_STATES, `${path}.previewState`, errors);
  });
}

function checkTicketFacts(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    str(o.ticketId, `${path}.ticketId`, errors);
    nullableStr(o.orderId, `${path}.orderId`, errors);
    nullableStr(o.customerRef, `${path}.customerRef`, errors);
    oneOf(o.status, TICKET_STATUSES, `${path}.status`, errors);
    str(o.summary, `${path}.summary`, errors, { allowEmpty: true });
  });
}

function checkInputActivityFacts(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    oneOf(o.surface, WORKSPACE_SURFACES, `${path}.surface`, errors);
    bool(o.typing, `${path}.typing`, errors);
    num(o.idleMs, `${path}.idleMs`, errors, { min: 0 });
    num(o.lastInputAtMs, `${path}.lastInputAtMs`, errors, { min: 0 });
  });
}

/** idleMs = timestampMs - lastInputAtMs (within 1 ms) and the last input is never in the future. */
function checkIdleRule(o: Record<string, unknown>, errors: string[]): void {
  const f = o.facts;
  if (typeof f !== "object" || f === null) return;
  const { idleMs, lastInputAtMs } = f as Record<string, unknown>;
  const ts = o.timestampMs;
  if (typeof ts !== "number" || typeof idleMs !== "number" || typeof lastInputAtMs !== "number") return;
  if (lastInputAtMs > ts) errors.push("observation.facts.lastInputAtMs: must be <= timestampMs");
  if (Math.abs(idleMs - (ts - lastInputAtMs)) > 1) {
    errors.push("observation.facts.idleMs: must equal timestampMs - lastInputAtMs (within 1 ms)");
  }
}

function checkRevisions(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    str(o.order, `${path}.order`, errors);
    str(o.email, `${path}.email`, errors);
  });
}

export function validateScreenObservation(value: unknown): ValidationResult<ScreenObservation> {
  const errors: string[] = [];
  object(value, "observation", errors, (o) => {
    checkSchemaVersion(o, "observation", errors);
    str(o.id, "observation.id", errors);
    str(o.sessionId, "observation.sessionId", errors);
    num(o.sequence, "observation.sequence", errors, { min: 1, integer: true });
    num(o.timestampMs, "observation.timestampMs", errors, { min: 0 });
    oneOf(o.source, OBSERVATION_SOURCES, "observation.source", errors);
    nullableStr(o.frameId, "observation.frameId", errors);
    nullableStr(o.sourceRevision, "observation.sourceRevision", errors);
    // frameId is null only for workspace heartbeats; vision observations always cite a processed frame.
    if (o.source === "vision" && o.frameId === null) errors.push("observation.frameId: required when source is vision");
    if (o.source === "workspace" && o.frameId !== null) errors.push("observation.frameId: must be null when source is workspace");
    // input_activity is the only workspace-sourced kind; it is not a screen moment and has no revision.
    if (o.kind === "input_activity" && o.source !== "workspace") errors.push("observation.source: input_activity must be workspace");
    if (o.kind !== "input_activity" && o.source === "workspace") errors.push("observation.source: workspace is only for input_activity");
    if (o.source === "workspace" && o.sourceRevision !== null) errors.push("observation.sourceRevision: must be null when source is workspace");
    nullableStr(o.entityRef, "observation.entityRef", errors);
    strArray(o.evidenceIds, "observation.evidenceIds", errors);
    switch (o.kind) {
      case "order_view":
        checkOrderFacts(o.facts, "observation.facts", errors);
        break;
      case "email_draft":
        checkEmailFacts(o.facts, "observation.facts", errors);
        break;
      case "ticket":
        checkTicketFacts(o.facts, "observation.facts", errors);
        break;
      case "input_activity":
        checkInputActivityFacts(o.facts, "observation.facts", errors);
        checkIdleRule(o, errors);
        break;
      default:
        errors.push(`observation.kind: expected one of ${OBSERVATION_KINDS.join("|")}`);
    }
  });
  return finish(value, errors);
}

export function validateScreenStatus(value: unknown): ValidationResult<ScreenStatus> {
  const errors: string[] = [];
  object(value, "status", errors, (o) => {
    checkSchemaVersion(o, "status", errors);
    str(o.sessionId, "status.sessionId", errors);
    oneOf(o.state, SCREEN_STATES, "status.state", errors);
    if (o.reason !== undefined) oneOf(o.reason, SCREEN_STATUS_REASONS, "status.reason", errors);
  });
  return finish(value, errors);
}

export function validateScreenEvidence(value: unknown): ValidationResult<ScreenEvidence> {
  const errors: string[] = [];
  object(value, "evidence", errors, (o) => {
    checkSchemaVersion(o, "evidence", errors);
    str(o.id, "evidence.id", errors);
    oneOf(o.kind, EVIDENCE_KINDS, "evidence.kind", errors);
    str(o.assetRef, "evidence.assetRef", errors);
    num(o.startMs, "evidence.startMs", errors, { min: 0 });
    num(o.endMs, "evidence.endMs", errors, { min: 0 });
    if (typeof o.startMs === "number" && typeof o.endMs === "number" && o.endMs < o.startMs) {
      errors.push("evidence.endMs: must be >= startMs");
    }
  });
  return finish(value, errors);
}

export function validateActionCheckpoint(value: unknown): ValidationResult<ActionCheckpoint> {
  const errors: string[] = [];
  object(value, "checkpoint", errors, (o) => {
    checkSchemaVersion(o, "checkpoint", errors);
    str(o.id, "checkpoint.id", errors);
    str(o.sessionId, "checkpoint.sessionId", errors);
    num(o.timestampMs, "checkpoint.timestampMs", errors, { min: 0 });
    strArray(o.observationIds, "checkpoint.observationIds", errors);
    checkRevisions(o.revisions, "checkpoint.revisions", errors);
    if ("facts" in o) errors.push("checkpoint.facts: not part of the contract; read facts from the referenced observations");
    if (o.action !== "send") errors.push("checkpoint.action: expected send");
  });
  return finish(value, errors);
}

export function validateCheckpointReply(value: unknown): ValidationResult<CheckpointReply> {
  const errors: string[] = [];
  object(value, "reply", errors, (o) => {
    checkSchemaVersion(o, "reply", errors);
    str(o.checkpointId, "reply.checkpointId", errors);
    oneOf(o.status, CHECKPOINT_STATUSES, "reply.status", errors);
    str(o.message, "reply.message", errors);
    strArray(o.evidenceIds, "reply.evidenceIds", errors);
    checkRevisions(o.basedOn, "reply.basedOn", errors);
  });
  return finish(value, errors);
}

/**
 * Semantic check on top of validateActionCheckpoint: observationIds must include
 * the latest order observation and the latest email-draft observation among
 * `observations` (everything the workspace emitted up to the checkpoint).
 */
export function checkpointCoversLatest(
  checkpoint: ActionCheckpoint,
  observations: readonly ScreenObservation[],
): ValidationResult<ActionCheckpoint> {
  const errors: string[] = [];
  for (const kind of ["order_view", "email_draft"] as const) {
    const latest = observations.filter((o) => o.kind === kind).at(-1);
    if (!latest) errors.push(`checkpoint: no ${kind} observation exists yet`);
    else if (!checkpoint.observationIds.includes(latest.id)) {
      errors.push(`checkpoint.observationIds: missing latest ${kind} observation ${latest.id}`);
    }
  }
  return finish(checkpoint, errors);
}

/** True when the reply judged exactly the revisions the workspace holds now; otherwise it must not be applied. */
export function replyIsCurrent(reply: CheckpointReply, current: WorkspaceRevisions): boolean {
  return reply.basedOn.order === current.order && reply.basedOn.email === current.email;
}

export type CheckpointFacts =
  | { incomplete: false; order: OrderFacts; email: EmailDraftFacts }
  | { incomplete: true; reason: string };

/**
 * The order and email facts a checkpoint refers to, read from the vision observations it
 * references. Anything missing or unmatched yields {incomplete: true, reason}, which the
 * agent must treat as unknown, never as clear. An observation counts only if it is from the
 * checkpoint's session, has source "vision" and its sourceRevision equals the checkpoint's
 * revision for that surface.
 */
export function factsFromCheckpoint(
  checkpoint: ActionCheckpoint,
  observations: readonly ScreenObservation[],
): CheckpointFacts {
  const surfaces = [
    { kind: "order_view", key: "order" },
    { kind: "email_draft", key: "email" },
  ] as const;
  const found: Partial<Record<"order" | "email", ScreenObservation>> = {};
  for (const { kind, key } of surfaces) {
    const referenced = observations.filter((o) => o.kind === kind && checkpoint.observationIds.includes(o.id));
    if (referenced.length === 0) return { incomplete: true, reason: `no ${kind} observation referenced by the checkpoint is available` };
    const matching = referenced.filter(
      (o) => o.source === "vision" && o.sessionId === checkpoint.sessionId && o.sourceRevision === checkpoint.revisions[key],
    );
    if (matching.length === 0) {
      return { incomplete: true, reason: `${kind} observation does not match the checkpoint's ${key} revision (must be vision-sourced, same session, same revision)` };
    }
    if (matching.length > 1) return { incomplete: true, reason: `more than one ${kind} observation matches the checkpoint's ${key} revision` };
    found[key] = matching[0];
  }
  const { order, email } = found;
  if (order === undefined || email === undefined) return { incomplete: true, reason: "order or email observation missing" };
  return {
    incomplete: false,
    order: structuredClone(order.facts as OrderFacts),
    email: structuredClone(email.facts as EmailDraftFacts),
  };
}
