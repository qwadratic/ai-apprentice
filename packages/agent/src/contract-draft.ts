// ScreenBridge v1 DRAFT (TASK-1 / TASK-3.1).
//
// This is stream B's proposal of the only interface between stream A (screen,
// workspace) and stream B (agent, voice, knowledge). Stream A writes the real
// implementation in packages/contracts; until then B develops against this file
// and the fakes in ./fake. A change to any type here goes through a small PR
// that both owners approve. Never extend the facts schema silently.
//
// Rules of the contract:
// - every timestampMs counts from the single sessionEpochMs passed to start();
// - screen facts describe only what is visible; reasons and rules are the
//   agent's job, never an observation's;
// - an unrecognised entity is entityRef = null, not a guess;
// - input_activity is a heartbeat emitted by OUR demo workspace (screen capture
//   cannot see keystrokes in other apps); it exists so the agent can stay quiet
//   while the expert types.

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

/** Order table / order card. customerRef is a stable synthetic id such as "customer_07", or null when not recognised. */
export interface OrderFacts {
  customerRef: string | null;
  orderId: string;
  deliveryAddress: string;
  deliveryWindow: string;
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
  /** The summary line the person wrote about the finished work. */
  note: string;
}

export const WORKSPACE_SURFACES = ["order", "email", "ticket"] as const;
export type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number];

/** Heartbeat from the demo workspace, not from vision. */
export interface InputActivityFacts {
  surface: WorkspaceSurface;
  typing: boolean;
  /** Milliseconds since the last input event in the workspace. */
  idleMs: number;
}

export const OBSERVATION_KINDS = ["order_view", "email_draft", "ticket", "input_activity"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

interface ObservationBase {
  schemaVersion: SchemaVersion;
  id: string;
  sessionId: string;
  /** Strictly increasing per session, starting at 1. */
  sequence: number;
  /** Milliseconds since sessionEpochMs. */
  timestampMs: number;
  frameId: string;
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

export interface ScreenStatus {
  schemaVersion: SchemaVersion;
  sessionId: string;
  state: ScreenState;
  reason?: string;
}

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

/**
 * Raised by the demo workspace on Preview (and before Send).
 * observationIds MUST include the latest order observation and the latest
 * email-draft observation the workspace has produced so far.
 */
export interface ActionCheckpoint {
  schemaVersion: SchemaVersion;
  id: string;
  sessionId: string;
  timestampMs: number;
  observationIds: string[];
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
}

export type Unsubscribe = () => void;

export interface ScreenBridge {
  /** Begin capturing. All timestampMs are relative to sessionEpochMs (epoch ms). */
  start(opts: { sessionId: string; sessionEpochMs: number }): Promise<void>;
  /** Stop emitting observations and capturing. Anything not yet emitted must never be emitted. */
  pause(): Promise<void>;
  /** Continue after pause() without replaying or skipping time. */
  resume(): Promise<void>;
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
    str(o.orderId, `${path}.orderId`, errors);
    str(o.deliveryAddress, `${path}.deliveryAddress`, errors);
    str(o.deliveryWindow, `${path}.deliveryWindow`, errors);
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
    str(o.note, `${path}.note`, errors, { allowEmpty: true });
  });
}

function checkInputActivityFacts(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    oneOf(o.surface, WORKSPACE_SURFACES, `${path}.surface`, errors);
    bool(o.typing, `${path}.typing`, errors);
    num(o.idleMs, `${path}.idleMs`, errors, { min: 0 });
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
    str(o.frameId, "observation.frameId", errors);
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
    optionalStr(o.reason, "status.reason", errors);
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
