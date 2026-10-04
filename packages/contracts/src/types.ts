/** Canonical ScreenBridge v1 fields accepted by both owners in doc-7. */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Facts schema
// ---------------------------------------------------------------------------

/** Order table / order card. customerRef is a stable synthetic id such as "customer_07", or null when not recognised. */
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
  /** The summary line the person wrote about the finished work. */
  summary: string;
}

export const WORKSPACE_SURFACES = ["order", "email", "ticket"] as const;
export type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number];

/** Heartbeat from the demo workspace, not from vision. */
export interface InputActivityFacts {
  surface: WorkspaceSurface;
  typing: boolean;
  /** Session-relative time of the last real input event. */
  lastInputAtMs: number;
  /** Milliseconds since the last input event in the workspace. */
  idleMs: number;
}

/** A labelled place on the processed frame; box is [x, y, w, h], normalised 0..1 to that frame. */
export interface ScreenRegion {
  id: string;
  label: string;
  box: [number, number, number, number];
}

/** Limits of a screen_activity observation; the conductor keeps every field within them. */
export const SCREEN_ACTIVITY_LIMITS = {
  app: 80, surface: 120, summary: 400, change: 300, pendingAction: 80,
  entity: 120, entities: 8, regionId: 32, regionLabel: 120, regions: 6,
} as const;

/**
 * Generic vision of any screen (any app, a whole shared display), from frames that show none of the
 * workspace surfaces. It never names an entity: entityRef and sourceRevision are always null.
 */
export interface ScreenActivityFacts {
  /** The application or site, e.g. "Gmail", or null when not visible. */
  app: string | null;
  /** What is open, e.g. "compose window". */
  surface: string;
  /** One or two sentences of what is visible. */
  summary: string;
  /** A visible sign of what just changed, or null. */
  change: string | null;
  /** Short visible items (names, amounts, cells, subjects); masked areas are never read. */
  entities: string[];
  /** The control the person seems about to use, e.g. "Send", or null. */
  pendingAction: string | null;
  /** The region of that control, or null. */
  pendingRegionId: string | null;
  regions: ScreenRegion[];
}

export const OBSERVATION_KINDS = ["order_view", "email_draft", "ticket", "input_activity", "screen_activity"] as const;
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
  source: "vision" | "workspace";
  frameId: string | null;
  /** Opaque workspace revision captured with the processed frame, or null. */
  sourceRevision: string | null;
  entityRef: string | null;
  /** Evidence that shows this observation; empty for workspace heartbeats. */
  evidenceIds: string[];
}

export type ScreenObservation =
  | (ObservationBase & { kind: "order_view"; facts: OrderFacts })
  | (ObservationBase & { kind: "email_draft"; facts: EmailDraftFacts })
  | (ObservationBase & { kind: "ticket"; facts: TicketFacts })
  | (ObservationBase & { kind: "input_activity"; facts: InputActivityFacts })
  | (ObservationBase & { kind: "screen_activity"; facts: ScreenActivityFacts });

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
  /** Opaque current workspace revisions. They contain no user content. */
  revisions: { order: string; email: string };
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
  /** Exact opaque revisions judged by the agent. */
  basedOn: { order: string; email: string };
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


export const CONTRACT_REVIEW_STATUS = 'accepted-doc-7' as const;
export interface SessionStart { sessionId: string; sessionEpochMs: number }
export type ResolvedEvidence = EvidenceRef;
export type CheckpointHandler = (checkpoint: ActionCheckpoint) => Promise<CheckpointReply>;
