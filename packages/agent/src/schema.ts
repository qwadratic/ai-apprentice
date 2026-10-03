// Stream B internal schema (doc-4 section 4): Work Map model, utterances, question
// candidates, coach commands, session state and the KnowledgeStore interface with an
// in-memory implementation. None of this is visible to stream A.

import { SCHEMA_VERSION, SCREEN_STATES } from "./contract-draft.ts";
import type { ScreenStatus } from "./contract-draft.ts";
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
  ValidationError,
} from "./validation.ts";
import type { ValidationResult } from "./validation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const STEP_STATUSES = ["observed", "inferred", "confirmed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const GUARDRAIL_STATUSES = ["proposed", "confirmed", "conflicted"] as const;
export type GuardrailStatus = (typeof GUARDRAIL_STATUSES)[number];

export const SCOPE_KINDS = ["customer", "class", "any"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** Limits where knowledge applies. customer_07's preference must never leak to other customers. */
export interface EntityScope {
  kind: ScopeKind;
  /** customer ids or class names; empty only for kind "any". */
  refs: string[];
}

export interface WorkStep {
  id: string;
  goal: string;
  action: string;
  conditions: string[];
  /** The expert's reason in plain words; null while unknown. */
  rationale: string | null;
  guardrailIds: string[];
  /** Screen moments (ScreenBridge evidence ids). */
  evidenceIds: string[];
  /** Expert quotes backing the rationale. */
  utteranceIds: string[];
  status: StepStatus;
  entityScope: EntityScope;
  environment: string;
  alternatives: string[];
  /** Open questions kept as unknown instead of being guessed. */
  unknowns: string[];
}

export interface Guardrail {
  id: string;
  condition: string;
  requiredAction: string;
  exceptions: string[];
  scope: EntityScope;
  rationale: string | null;
  evidenceIds: string[];
  utteranceIds: string[];
  status: GuardrailStatus;
  version: number;
}

export const SPEAKERS = ["expert", "agent"] as const;
export type Speaker = (typeof SPEAKERS)[number];

export interface Utterance {
  id: string;
  sessionId: string;
  speaker: Speaker;
  text: string;
  /** Milliseconds since sessionEpochMs. */
  startMs: number;
  endMs: number | null;
  /** false for interim transcripts; only final ones feed the Work Map. */
  final: boolean;
}

export const MAP_VERSION_REASONS = ["live", "review_confirmed", "review_corrected"] as const;
export type MapVersionReason = (typeof MAP_VERSION_REASONS)[number];

export interface MapVersion {
  id: string;
  sessionId: string;
  /** 1, 2, 3 ... strictly increasing per session. */
  version: number;
  createdAtMs: number;
  reason: MapVersionReason;
  steps: WorkStep[];
  guardrails: Guardrail[];
  /** Gaps still to ask about in Review. */
  gaps: string[];
}

export const QUESTION_KINDS = ["why", "exception", "limit", "unknown_branch", "follow_up", "teach_back"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_STATUSES = ["candidate", "queued", "asked", "answered", "dropped", "expired"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const POLICY_DECISIONS = ["ASK_NOW", "DEFER", "SKIP", "WARN"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export interface QuestionCandidate {
  id: string;
  sessionId: string;
  kind: QuestionKind;
  text: string;
  createdAtMs: number;
  triggerObservationIds: string[];
  evidenceIds: string[];
  priority: number;
  status: QuestionStatus;
  decision: PolicyDecision | null;
  decisionReason: string | null;
  /** Set only after the voice adapter reports the question was actually spoken. */
  spokenAtMs: number | null;
  answerUtteranceIds: string[];
}

export const COACH_KINDS = ["ask", "warn", "teach"] as const;
export type CoachKind = (typeof COACH_KINDS)[number];

/** What the single conversation coordinator tells the voice adapter to say. */
export interface CoachCommand {
  id: string;
  sessionId: string;
  kind: CoachKind;
  text: string;
  questionId: string | null;
  evidenceIds: string[];
  issuedAtMs: number;
}

export const COORDINATOR_PHASES = ["listening", "speaking", "thinking", "paused", "error"] as const;
export type CoordinatorPhase = (typeof COORDINATOR_PHASES)[number];

export interface CoordinatorState {
  phase: CoordinatorPhase;
  /** Command currently being spoken, if any. */
  speakingCommandId: string | null;
  /** Last time the expert was heard speaking or typing; basis for pause detection. */
  lastActivityMs: number | null;
  /** Question ids asked in the last 10 minutes, newest last. */
  recentQuestionIds: string[];
}

export const MODES = ["learn", "review", "teach"] as const;
export type Mode = (typeof MODES)[number];

export interface SessionState {
  sessionId: string;
  sessionEpochMs: number;
  mode: Mode;
  /** True only after both the microphone and the screen are confirmed stopped. */
  offRecord: boolean;
  screen: ScreenStatus | null;
  coordinator: CoordinatorState;
  latestMapVersion: number | null;
  /** Visible error, never swallowed. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function checkScope(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    oneOf(o.kind, SCOPE_KINDS, `${path}.kind`, errors);
    strArray(o.refs, `${path}.refs`, errors);
    if (o.kind !== "any" && Array.isArray(o.refs) && o.refs.length === 0) {
      errors.push(`${path}.refs: must not be empty for kind ${String(o.kind)}`);
    }
  });
}

function checkStep(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    str(o.id, `${path}.id`, errors);
    str(o.goal, `${path}.goal`, errors);
    str(o.action, `${path}.action`, errors);
    strArray(o.conditions, `${path}.conditions`, errors);
    nullableStr(o.rationale, `${path}.rationale`, errors);
    strArray(o.guardrailIds, `${path}.guardrailIds`, errors);
    strArray(o.evidenceIds, `${path}.evidenceIds`, errors);
    strArray(o.utteranceIds, `${path}.utteranceIds`, errors);
    oneOf(o.status, STEP_STATUSES, `${path}.status`, errors);
    checkScope(o.entityScope, `${path}.entityScope`, errors);
    str(o.environment, `${path}.environment`, errors);
    strArray(o.alternatives, `${path}.alternatives`, errors);
    strArray(o.unknowns, `${path}.unknowns`, errors);
    // A confirmed step needs a reason, a quote and a screen moment; observation alone is never a rule.
    if (o.status === "confirmed") {
      if (o.rationale === null) errors.push(`${path}: confirmed step needs a rationale`);
      if (Array.isArray(o.utteranceIds) && o.utteranceIds.length === 0) {
        errors.push(`${path}: confirmed step needs at least one utteranceId`);
      }
      if (Array.isArray(o.evidenceIds) && o.evidenceIds.length === 0) {
        errors.push(`${path}: confirmed step needs at least one evidenceId (a screen moment)`);
      }
    }
  });
}

function checkGuardrail(value: unknown, path: string, errors: string[]): void {
  object(value, path, errors, (o) => {
    str(o.id, `${path}.id`, errors);
    str(o.condition, `${path}.condition`, errors);
    str(o.requiredAction, `${path}.requiredAction`, errors);
    strArray(o.exceptions, `${path}.exceptions`, errors);
    checkScope(o.scope, `${path}.scope`, errors);
    nullableStr(o.rationale, `${path}.rationale`, errors);
    strArray(o.evidenceIds, `${path}.evidenceIds`, errors);
    strArray(o.utteranceIds, `${path}.utteranceIds`, errors);
    oneOf(o.status, GUARDRAIL_STATUSES, `${path}.status`, errors);
    num(o.version, `${path}.version`, errors, { min: 1, integer: true });
    if (o.status === "confirmed" && Array.isArray(o.utteranceIds) && o.utteranceIds.length === 0) {
      errors.push(`${path}: confirmed guardrail needs at least one utteranceId`);
    }
    if (o.status === "confirmed" && Array.isArray(o.evidenceIds) && o.evidenceIds.length === 0) {
      errors.push(`${path}: confirmed guardrail needs at least one evidenceId (a screen moment)`);
    }
  });
}

export function validateWorkStep(value: unknown): ValidationResult<WorkStep> {
  const errors: string[] = [];
  checkStep(value, "step", errors);
  return finish(value, errors);
}

export function validateGuardrail(value: unknown): ValidationResult<Guardrail> {
  const errors: string[] = [];
  checkGuardrail(value, "guardrail", errors);
  return finish(value, errors);
}

export function validateUtterance(value: unknown): ValidationResult<Utterance> {
  const errors: string[] = [];
  object(value, "utterance", errors, (o) => {
    str(o.id, "utterance.id", errors);
    str(o.sessionId, "utterance.sessionId", errors);
    oneOf(o.speaker, SPEAKERS, "utterance.speaker", errors);
    str(o.text, "utterance.text", errors);
    num(o.startMs, "utterance.startMs", errors, { min: 0 });
    if (o.endMs !== null) num(o.endMs, "utterance.endMs", errors, { min: 0 });
    bool(o.final, "utterance.final", errors);
    if (typeof o.startMs === "number" && typeof o.endMs === "number" && o.endMs < o.startMs) {
      errors.push("utterance.endMs: must be >= startMs");
    }
  });
  return finish(value, errors);
}

export function validateMapVersion(value: unknown): ValidationResult<MapVersion> {
  const errors: string[] = [];
  object(value, "map", errors, (o) => {
    str(o.id, "map.id", errors);
    str(o.sessionId, "map.sessionId", errors);
    num(o.version, "map.version", errors, { min: 1, integer: true });
    num(o.createdAtMs, "map.createdAtMs", errors, { min: 0 });
    oneOf(o.reason, MAP_VERSION_REASONS, "map.reason", errors);
    arrayOf(o.steps, "map.steps", errors, checkStep);
    arrayOf(o.guardrails, "map.guardrails", errors, checkGuardrail);
    strArray(o.gaps, "map.gaps", errors);
    // Steps may only reference guardrails that exist in the same version.
    if (Array.isArray(o.steps) && Array.isArray(o.guardrails)) {
      const ids = new Set(o.guardrails.map((g) => (g as { id?: unknown })?.id));
      o.steps.forEach((s, i) => {
        const refs = (s as { guardrailIds?: unknown })?.guardrailIds;
        if (Array.isArray(refs)) {
          for (const r of refs) if (!ids.has(r)) errors.push(`map.steps[${i}].guardrailIds: unknown guardrail ${String(r)}`);
        }
      });
    }
  });
  return finish(value, errors);
}

export function validateQuestionCandidate(value: unknown): ValidationResult<QuestionCandidate> {
  const errors: string[] = [];
  object(value, "question", errors, (o) => {
    str(o.id, "question.id", errors);
    str(o.sessionId, "question.sessionId", errors);
    oneOf(o.kind, QUESTION_KINDS, "question.kind", errors);
    str(o.text, "question.text", errors);
    num(o.createdAtMs, "question.createdAtMs", errors, { min: 0 });
    strArray(o.triggerObservationIds, "question.triggerObservationIds", errors);
    strArray(o.evidenceIds, "question.evidenceIds", errors);
    num(o.priority, "question.priority", errors);
    oneOf(o.status, QUESTION_STATUSES, "question.status", errors);
    if (o.decision !== null) oneOf(o.decision, POLICY_DECISIONS, "question.decision", errors);
    nullableStr(o.decisionReason, "question.decisionReason", errors);
    if (o.spokenAtMs !== null) num(o.spokenAtMs, "question.spokenAtMs", errors, { min: 0 });
    strArray(o.answerUtteranceIds, "question.answerUtteranceIds", errors);
    // "asked" and "answered" mean actually spoken, never merely decided.
    if ((o.status === "asked" || o.status === "answered") && o.spokenAtMs === null) {
      errors.push(`question.spokenAtMs: required when status is ${String(o.status)}`);
    }
  });
  return finish(value, errors);
}

export function validateCoachCommand(value: unknown): ValidationResult<CoachCommand> {
  const errors: string[] = [];
  object(value, "command", errors, (o) => {
    str(o.id, "command.id", errors);
    str(o.sessionId, "command.sessionId", errors);
    oneOf(o.kind, COACH_KINDS, "command.kind", errors);
    str(o.text, "command.text", errors);
    nullableStr(o.questionId, "command.questionId", errors);
    strArray(o.evidenceIds, "command.evidenceIds", errors);
    num(o.issuedAtMs, "command.issuedAtMs", errors, { min: 0 });
  });
  return finish(value, errors);
}

export function validateSessionState(value: unknown): ValidationResult<SessionState> {
  const errors: string[] = [];
  object(value, "session", errors, (o) => {
    str(o.sessionId, "session.sessionId", errors);
    num(o.sessionEpochMs, "session.sessionEpochMs", errors, { min: 0 });
    oneOf(o.mode, MODES, "session.mode", errors);
    bool(o.offRecord, "session.offRecord", errors);
    if (o.screen !== null) {
      object(o.screen, "session.screen", errors, (s) => {
        if (s.schemaVersion !== SCHEMA_VERSION) errors.push(`session.screen.schemaVersion: expected ${SCHEMA_VERSION}`);
        str(s.sessionId, "session.screen.sessionId", errors);
        oneOf(s.state, SCREEN_STATES, "session.screen.state", errors);
        optionalStr(s.reason, "session.screen.reason", errors);
      });
    }
    object(o.coordinator, "session.coordinator", errors, (c) => {
      oneOf(c.phase, COORDINATOR_PHASES, "session.coordinator.phase", errors);
      nullableStr(c.speakingCommandId, "session.coordinator.speakingCommandId", errors);
      if (c.lastActivityMs !== null) num(c.lastActivityMs, "session.coordinator.lastActivityMs", errors, { min: 0 });
      strArray(c.recentQuestionIds, "session.coordinator.recentQuestionIds", errors);
    });
    if (o.latestMapVersion !== null) num(o.latestMapVersion, "session.latestMapVersion", errors, { min: 1, integer: true });
    nullableStr(o.error, "session.error", errors);
  });
  return finish(value, errors);
}

// ---------------------------------------------------------------------------
// KnowledgeStore
// ---------------------------------------------------------------------------

/**
 * Persistence for everything stream B owns (maps, questions, transcripts, session state).
 * Async so the SQLite-backed API client (TASK-3.7) can implement the same interface.
 * Implementations validate on write and return copies, never shared references.
 */
export interface KnowledgeStore {
  saveSession(state: SessionState): Promise<void>;
  getSession(sessionId: string): Promise<SessionState | null>;

  /** Upserts by id (interim transcripts are replaced by their final version). */
  saveUtterance(utterance: Utterance): Promise<void>;
  listUtterances(sessionId: string): Promise<Utterance[]>;

  /** Upserts by id (a question moves candidate -> queued -> asked -> answered). */
  saveQuestion(question: QuestionCandidate): Promise<void>;
  listQuestions(sessionId: string): Promise<QuestionCandidate[]>;

  /** Appends a map version; version must be latest + 1 (or 1 for the first). */
  saveMapVersion(map: MapVersion): Promise<void>;
  getMapVersion(sessionId: string, version: number): Promise<MapVersion | null>;
  getLatestMap(sessionId: string): Promise<MapVersion | null>;
  listMapVersions(sessionId: string): Promise<MapVersion[]>;
}

function must<T>(what: string, r: ValidationResult<T>): T {
  if (!r.ok) throw new ValidationError(what, r.errors);
  return r.value;
}

function copy<T>(v: T): T {
  return structuredClone(v);
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private sessions = new Map<string, SessionState>();
  private utterances = new Map<string, Map<string, Utterance>>();
  private questions = new Map<string, Map<string, QuestionCandidate>>();
  private maps = new Map<string, MapVersion[]>();

  async saveSession(state: SessionState): Promise<void> {
    this.sessions.set(state.sessionId, copy(must("session", validateSessionState(state))));
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    const s = this.sessions.get(sessionId);
    return s ? copy(s) : null;
  }

  async saveUtterance(utterance: Utterance): Promise<void> {
    const u = must("utterance", validateUtterance(utterance));
    this.bucket(this.utterances, u.sessionId).set(u.id, copy(u));
  }

  async listUtterances(sessionId: string): Promise<Utterance[]> {
    return [...(this.utterances.get(sessionId)?.values() ?? [])].sort((a, b) => a.startMs - b.startMs).map(copy);
  }

  async saveQuestion(question: QuestionCandidate): Promise<void> {
    const q = must("question", validateQuestionCandidate(question));
    this.bucket(this.questions, q.sessionId).set(q.id, copy(q));
  }

  async listQuestions(sessionId: string): Promise<QuestionCandidate[]> {
    return [...(this.questions.get(sessionId)?.values() ?? [])].sort((a, b) => a.createdAtMs - b.createdAtMs).map(copy);
  }

  async saveMapVersion(map: MapVersion): Promise<void> {
    const m = must("map", validateMapVersion(map));
    const list = this.maps.get(m.sessionId) ?? [];
    const expected = (list.at(-1)?.version ?? 0) + 1;
    if (m.version !== expected) {
      throw new ValidationError("map", [`map.version: expected ${expected}, got ${m.version}`]);
    }
    list.push(copy(m));
    this.maps.set(m.sessionId, list);
  }

  async getMapVersion(sessionId: string, version: number): Promise<MapVersion | null> {
    const m = this.maps.get(sessionId)?.find((x) => x.version === version);
    return m ? copy(m) : null;
  }

  async getLatestMap(sessionId: string): Promise<MapVersion | null> {
    const m = this.maps.get(sessionId)?.at(-1);
    return m ? copy(m) : null;
  }

  async listMapVersions(sessionId: string): Promise<MapVersion[]> {
    return (this.maps.get(sessionId) ?? []).map(copy);
  }

  private bucket<T>(root: Map<string, Map<string, T>>, sessionId: string): Map<string, T> {
    let b = root.get(sessionId);
    if (!b) {
      b = new Map();
      root.set(sessionId, b);
    }
    return b;
  }
}
