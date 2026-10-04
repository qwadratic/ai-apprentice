// Conversation policy: decides ASK_NOW / DEFER / SKIP (Learn), PREDICT / WARN (Teach) from observations.
// Deterministic. First a gate that never asks while the expert types, speaks, is being spoken to, is off the record,
// or while the screen is still changing; that skips a topic already asked or already answered in the map; and that
// holds a question budget and a cooldown. Only candidates that pass the gate are ranked. WARN (Teach) bypasses budget
// and cooldown. Every decision is logged as a BrainDecision. Time comes in as arguments (or the injected `now`);
// nothing is scheduled here.
import type { ScreenObservation } from "@apprentice/contracts";
import { isAnswered } from "../knowledge/types.ts";
import type { Question, Topic, WorkMap } from "../knowledge/types.ts";
import type { Mode } from "../schema.ts";
import { buildPrediction } from "../tutor/predict.ts";
import { getPersona } from "./personas.ts";
import type { Persona, PersonaId } from "./personas.ts";
import { QuietTracker, quietBlockers } from "./quiet.ts";
import { KIND_TOPIC, renderLearnQuestion } from "./topics.ts";
import type { BrainUtterance, CandidateKind } from "./topics.ts";
import type { BrainDecision, BudgetSnapshot, PolicyReason, QuietSnapshot, ReviewItem } from "./types.ts";

export interface PolicyOptions {
  mode?: Mode;
  persona?: PersonaId;
  /** Question budget per rolling window; defaults to the persona's upper bound. */
  budget?: number;
  cooldownMs?: number;
  /** Rolling window of the budget. Default 10 minutes. */
  windowMs?: number;
  /** A candidate still unasked after this long is stale and dropped. Default 30 s. */
  maxAgeMs?: number;
  /** How long a question held for Review stays valid. Default 2 hours. */
  reviewTtlMs?: number;
  /** Session-relative "now" in milliseconds, used when a call gives no time. */
  now?: () => number;
  /** Called with every decision as it is logged. */
  onDecision?: (d: BrainDecision) => void;
}

type CandidateState = "pending" | "asking" | "asked" | "review" | "dropped";

export interface PolicyCandidate {
  id: string;
  kind: CandidateKind;
  topic: Topic | null;
  observationId: string;
  evidenceIds: string[];
  createdAtMs: number;
  priority: number;
  entityRef: string | null;
  orderId: string | null;
  customerRef: string | null;
  detail: string | null;
  /** What happened on screen, in words. */
  note: string;
  state: CandidateState;
  lastBlockKey: string | null;
  expiresAtMs: number | null;
  heldAtMs: number | null;
}

const PRIORITY: Readonly<Record<CandidateKind, number>> = {
  decision_point: 5,
  preview_opened: 4,
  attachment_removed: 3,
  recipient_changed: 3,
  body_text_added: 2,
  attachment_added: 1,
  ticket_done: 1,
};

const NOTE: Readonly<Record<CandidateKind, string>> = {
  decision_point: "an order was opened",
  preview_opened: "Preview was opened before Send",
  attachment_removed: "an attachment was removed",
  recipient_changed: "the recipient was changed",
  body_text_added: "order details were typed into the message",
  attachment_added: "an attachment was added",
  ticket_done: "the ticket was marked done",
};

const seconds = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

/** One topic is asked once per entity; the stop-and-ask question is asked once per session. */
function dedupeKey(topic: Topic, entityRef: string | null): string {
  return topic === "guardrail" ? topic : `${topic}:${entityRef ?? ""}`;
}

function mentionsOrder(text: string, order: { orderId: string | null; deliveryAddress: string | null; deliveryWindow: string | null }): boolean {
  const body = text.toLowerCase();
  return [order.deliveryAddress, order.deliveryWindow, order.orderId].some((v) => v !== null && v.length > 3 && body.includes(v.toLowerCase()));
}

export class ConversationPolicy {
  readonly mode: Mode;
  readonly persona: Persona;
  /** Every decision, oldest first. */
  readonly log: BrainDecision[] = [];
  readonly candidates: PolicyCandidate[] = [];

  private readonly options: PolicyOptions;
  private readonly quiet = new QuietTracker();
  private map: WorkMap | null = null;
  private seq = 0;
  private candidateSeq = 0;
  private questionSeq = 0;
  private askedAt: number[] = [];
  private lastFinishedAtMs: number | null = null;
  private open: { id: string; candidateId: string } | null = null;
  private askedKeys = new Set<string>();
  private predictedOrders = new Set<string>();
  private lastObservationMs = 0;
  // Change detection on the observed stream.
  private order: { orderId: string | null; customerRef: string | null; deliveryAddress: string | null; deliveryWindow: string | null } | null = null;
  private prevEmail: { recipientRef: string | null; bodyText: string; attachments: { kind: string }[]; previewState: string } | null = null;
  private bodyAsked = new Set<string>();

  constructor(options: PolicyOptions = {}) {
    this.options = options;
    this.mode = options.mode ?? "learn";
    this.persona = getPersona(options.persona);
  }

  // -- inputs ---------------------------------------------------------------

  private time(atMs?: number): number {
    return atMs ?? this.options.now?.() ?? this.lastObservationMs;
  }

  /** The latest confirmed map (Teach) or the working map (Learn), for "answered in map" and PREDICT. */
  setMap(map: WorkMap | null): void {
    this.map = map;
  }

  humanSpeech(speaking: boolean, atMs?: number): void {
    this.quiet.setHumanSpeaking(speaking, this.time(atMs));
  }

  agentSpeech(speaking: boolean): void {
    this.quiet.setAgentSpeaking(speaking);
  }

  /** Off the record: nothing is observed, everything pending is dropped, an open question is cancelled. */
  setOffRecord(on: boolean, atMs?: number): void {
    const now = this.time(atMs);
    if (on === this.quiet.isOffRecord()) return;
    this.quiet.setOffRecord(on);
    // Changes across the gap are not attributed to the expert's actions: the next draft observation is a new baseline.
    this.prevEmail = null;
    if (!on) return;
    this.open = null;
    for (const c of this.candidates) {
      if (c.state === "pending" || c.state === "asking") {
        c.state = "dropped";
        this.record(now, "SKIP", ["off_record"], "The expert went off the record; nothing from this moment is asked about.", c);
      }
    }
  }

  /** Feed every observation, in order. */
  observe(obs: ScreenObservation): void {
    if (this.quiet.isOffRecord()) return;
    this.lastObservationMs = Math.max(this.lastObservationMs, obs.timestampMs);
    this.quiet.observe(obs);
    if (this.mode === "review" || obs.kind === "input_activity") return;
    const evidenceIds = [...obs.evidenceIds];

    if (obs.kind === "order_view") {
      const f = obs.facts;
      const same = this.order !== null && this.order.orderId === f.orderId && this.order.customerRef === f.customerRef;
      this.order = f;
      if (same) return;
      this.prevEmail = null;
      if (this.mode === "teach") this.consider("decision_point", obs, evidenceIds, null);
      return;
    }
    if (this.mode === "teach") return;
    if (obs.kind === "ticket") {
      if (obs.facts.status === "done") this.consider("ticket_done", obs, evidenceIds, null);
      return;
    }
    if (obs.kind !== "email_draft") return;

    const email = obs.facts;
    const prev = this.prevEmail;
    this.prevEmail = email;
    if (prev === null) return;
    const gone = prev.attachments.length - email.attachments.length;
    if (gone > 0) this.consider("attachment_removed", obs, evidenceIds, prev.attachments[0]?.kind ?? null);
    else if (gone < 0) this.consider("attachment_added", obs, evidenceIds, email.attachments[0]?.kind ?? null);
    if (prev.recipientRef !== null && email.recipientRef !== prev.recipientRef) this.consider("recipient_changed", obs, evidenceIds, null);
    const key = this.order?.orderId ?? "";
    if (this.order !== null && !this.bodyAsked.has(key) && mentionsOrder(email.bodyText, this.order) && !mentionsOrder(prev.bodyText, this.order)) {
      this.bodyAsked.add(key);
      this.consider("body_text_added", obs, evidenceIds, null);
    }
    if (prev.previewState !== "preview" && email.previewState === "preview") this.consider("preview_opened", obs, evidenceIds, null);
  }

  private consider(kind: CandidateKind, obs: ScreenObservation, evidenceIds: string[], detail: string | null): void {
    const topic = KIND_TOPIC[kind];
    const c: PolicyCandidate = {
      id: `cand-${++this.candidateSeq}`,
      kind,
      topic,
      observationId: obs.id,
      evidenceIds,
      createdAtMs: obs.timestampMs,
      priority: PRIORITY[kind],
      entityRef: obs.entityRef,
      orderId: this.order?.orderId ?? null,
      customerRef: this.order?.customerRef ?? null,
      detail,
      note: NOTE[kind],
      state: "pending",
      lastBlockKey: null,
      expiresAtMs: null,
      heldAtMs: null,
    };
    this.candidates.push(c);
    if (kind !== "decision_point" && topic === null) {
      c.state = "dropped";
      this.record(obs.timestampMs, "SKIP", ["visible_on_screen"], `${c.note}: visible on screen and routine, nothing to ask.`, c);
    }
  }

  // -- snapshots ------------------------------------------------------------

  private quietNow(now: number): QuietSnapshot {
    return this.quiet.snapshot(now, {
      inputPauseMs: this.persona.inputPauseMs,
      screenStableMs: this.persona.screenStableMs,
      humanQuietMs: this.persona.humanQuietMs,
    });
  }

  private budgetNow(now: number): BudgetSnapshot {
    const windowMs = this.options.windowMs ?? 600_000;
    const cooldownMs = this.options.cooldownMs ?? this.persona.cooldownMs;
    const asked = this.askedAt.filter((t) => now - t < windowMs).length;
    const left = this.lastFinishedAtMs === null ? 0 : Math.max(0, cooldownMs - (now - this.lastFinishedAtMs));
    return { asked, max: this.options.budget ?? this.persona.questionsPer10Min.max, windowMs, cooldownMs, cooldownLeftMs: left };
  }

  /** Questions asked so far in this session (the budget counts only the rolling window). */
  get questionsAsked(): number {
    return this.askedAt.length;
  }

  private record(
    atMs: number,
    decision: BrainDecision["decision"],
    reasons: PolicyReason[],
    whyNow: string,
    c: PolicyCandidate | null,
    extra: Partial<Pick<BrainDecision, "questionId" | "question" | "utterance" | "prediction" | "deferTo" | "expiresAtMs" | "deliver" | "evidenceIds" | "topic">> = {},
  ): BrainDecision {
    const d: BrainDecision = {
      seq: ++this.seq,
      atMs,
      mode: this.mode,
      persona: this.persona.id,
      decision,
      reasons,
      whyNow,
      quiet: this.quietNow(atMs),
      evidenceIds: extra.evidenceIds ?? [...(c?.evidenceIds ?? [])],
      topic: extra.topic ?? c?.topic ?? null,
      candidateId: c?.id ?? null,
      budget: this.budgetNow(atMs),
      questionId: extra.questionId ?? null,
      question: extra.question ?? null,
      utterance: extra.utterance ?? null,
      prediction: extra.prediction ?? null,
      deferTo: extra.deferTo ?? null,
      expiresAtMs: extra.expiresAtMs ?? null,
      deliver: extra.deliver ?? null,
    };
    this.log.push(d);
    this.options.onDecision?.(d);
    return d;
  }

  // -- the gate and the ranking --------------------------------------------

  private isDuplicate(c: PolicyCandidate): boolean {
    return c.topic !== null && this.askedKeys.has(dedupeKey(c.topic, c.entityRef));
  }

  private answeredInMap(c: PolicyCandidate): boolean {
    return c.topic !== null && this.map !== null && isAnswered(this.map, c.topic, c.entityRef);
  }

  /** Call regularly (every few hundred milliseconds) and after each event. Returns the decisions made now; at most one is ASK_NOW or PREDICT. */
  tick(nowMs?: number): BrainDecision[] {
    const now = this.time(nowMs);
    const out: BrainDecision[] = [];
    const cfg = { maxAgeMs: this.options.maxAgeMs ?? 30_000, reviewTtlMs: this.options.reviewTtlMs ?? 7_200_000 };

    for (const c of this.candidates) {
      if (c.state === "pending" && now - c.createdAtMs > cfg.maxAgeMs) {
        c.state = "dropped";
        out.push(this.record(now, "SKIP", ["stale"], `${c.note}, ${seconds(now - c.createdAtMs)} ago: too old to ask about now.`, c));
      } else if (c.state === "review" && c.expiresAtMs !== null && now >= c.expiresAtMs) {
        c.state = "dropped";
        out.push(this.record(now, "SKIP", ["stale"], `${c.note}: held for Review but expired.`, c));
      }
    }

    if (this.mode === "teach") return [...out, ...this.tickTeach(now)];
    if (this.mode !== "learn") return out;

    for (const c of this.candidates) {
      if (c.state !== "pending") continue;
      if (this.isDuplicate(c)) {
        c.state = "dropped";
        out.push(this.record(now, "SKIP", ["duplicate_topic"], `${c.note}: the same topic was already asked about.`, c));
      } else if (this.answeredInMap(c)) {
        c.state = "dropped";
        out.push(this.record(now, "SKIP", ["answered_in_map"], `${c.note}: the map already holds the expert's answer.`, c));
      }
    }
    const pending = this.candidates.filter((c) => c.state === "pending");
    if (pending.length === 0) return out;

    const q = this.quietNow(now);
    const budget = this.budgetNow(now);
    if (budget.asked >= budget.max) {
      for (const c of pending) {
        c.state = "review";
        c.heldAtMs = now;
        c.expiresAtMs = now + cfg.reviewTtlMs;
        out.push(
          this.record(now, "DEFER", ["budget"], `${c.note}: question budget used (${budget.asked} of ${budget.max}); held for Review.`, c, {
            deferTo: "review",
            expiresAtMs: c.expiresAtMs,
          }),
        );
      }
      return out;
    }

    const blockers: PolicyReason[] = quietBlockers(q);
    if (this.open !== null) blockers.push("question_open");
    if (budget.cooldownLeftMs > 0) blockers.push("cooldown");
    if (blockers.length > 0) {
      const key = blockers.join(",");
      for (const c of pending) {
        if (c.lastBlockKey === key) continue;
        c.lastBlockKey = key;
        out.push(this.record(now, "DEFER", [...blockers], `${c.note}: not a natural pause yet (${blockers.join(", ").replace(/_/g, " ")}).`, c, { deferTo: "next_pause" }));
      }
      return out;
    }

    // The gate is open: rank.
    const top = [...pending].sort((a, b) => b.priority - a.priority || a.createdAtMs - b.createdAtMs)[0];
    if (top === undefined) return out;
    const topic = top.topic;
    const text = topic === null ? null : renderLearnQuestion(top.kind, { entityRef: top.entityRef, orderId: top.orderId, detail: top.detail }, this.persona.maxWords);
    if (topic === null || text === null) {
      top.state = "dropped";
      out.push(this.record(now, "SKIP", ["visible_on_screen"], `${top.note}: no question template for this change.`, top));
      return out;
    }
    top.state = "asking";
    this.askedAt.push(now);
    this.askedKeys.add(dedupeKey(topic, top.entityRef));
    const id = `q-L-${++this.questionSeq}`;
    this.open = { id, candidateId: top.id };
    const question: Question = { id, topic, text, evidenceIds: [...top.evidenceIds], targetId: null, entityRef: top.entityRef };
    const utterance: BrainUtterance = { text, delivery: [...this.persona.deliveryTags], maxWords: this.persona.maxWords };
    const after = this.budgetNow(now);
    out.push(
      this.record(
        now,
        "ASK_NOW",
        ["natural_pause"],
        `${top.note}; ${q.inputIdleMs === null ? "no typing so far" : `${seconds(q.inputIdleMs)} without input`}, screen stable for ${seconds(q.screenStableMs)}; question ${after.asked} of ${after.max}.`,
        top,
        { question, questionId: id, utterance },
      ),
    );
    return out;
  }

  private tickTeach(now: number): BrainDecision[] {
    const out: BrainDecision[] = [];
    for (const c of this.candidates) {
      if (c.state !== "pending" || c.kind !== "decision_point") continue;
      const key = c.orderId ?? c.id;
      if (this.predictedOrders.has(key)) {
        c.state = "dropped";
        out.push(this.record(now, "SKIP", ["already_predicted"], `${c.note}: already asked what the new hire would do here.`, c));
        continue;
      }
      const order = {
        customerRef: c.customerRef,
        orderId: c.orderId,
        deliveryAddress: null,
        deliveryWindow: null,
      };
      const prediction = buildPrediction(order, this.map, this.persona);
      if (prediction.expect === "usual") {
        c.state = "dropped";
        out.push(this.record(now, "SKIP", ["no_decision_point"], `${c.note}: the map has nothing to decide here, so nothing to predict.`, c));
        continue;
      }
      if (this.persona.predictStyle === "before_send") {
        c.state = "dropped";
        out.push(this.record(now, "SKIP", ["persona_predicts_before_send"], `${c.note}: this persona asks for a prediction only before Send.`, c));
        continue;
      }
      const q = this.quietNow(now);
      const blockers: PolicyReason[] = quietBlockers(q);
      if (this.open !== null) blockers.push("question_open");
      if (blockers.length > 0) {
        const key2 = blockers.join(",");
        if (c.lastBlockKey !== key2) {
          c.lastBlockKey = key2;
          out.push(this.record(now, "DEFER", [...blockers], `${c.note}: not a natural pause yet (${blockers.join(", ").replace(/_/g, " ")}).`, c, { deferTo: "next_pause" }));
        }
        continue;
      }
      c.state = "asking";
      this.predictedOrders.add(key);
      const id = `q-P-${++this.questionSeq}`;
      this.open = { id, candidateId: c.id };
      const utterance: BrainUtterance = { text: prediction.question, delivery: [...this.persona.deliveryTags], maxWords: this.persona.maxWords };
      out.push(
        this.record(now, "PREDICT", ["natural_pause", "bypass_budget"], `${c.note} and the map has a decision here (${prediction.expect === "ask" ? "do not guess" : "the expert's way"}); asking for a prediction.`, c, {
          utterance,
          questionId: id,
          prediction,
          evidenceIds: prediction.evidenceIds,
          topic: "predict_next",
        }),
      );
      break;
    }
    return out;
  }

  // -- question lifecycle ---------------------------------------------------

  /** The question was spoken and the answer is in (or the expert declined): the cooldown starts. */
  finishQuestion(questionId: string, nowMs?: number): void {
    const now = this.time(nowMs);
    if (this.open?.id !== questionId) return;
    const c = this.candidates.find((x) => x.id === this.open?.candidateId);
    if (c) c.state = "asked";
    this.open = null;
    this.lastFinishedAtMs = now;
  }

  /** The question was never actually spoken (paused, cancelled): it does not count, and it goes back to the queue. */
  cancelQuestion(questionId: string, nowMs?: number): void {
    const now = this.time(nowMs);
    if (this.open?.id !== questionId) return;
    const c = this.candidates.find((x) => x.id === this.open?.candidateId);
    this.open = null;
    if (!c) return;
    c.state = "pending";
    c.lastBlockKey = null;
    if (c.kind === "decision_point") {
      this.predictedOrders.delete(c.orderId ?? c.id);
    } else {
      this.askedAt.pop();
      if (c.topic !== null) this.askedKeys.delete(dedupeKey(c.topic, c.entityRef));
    }
    this.record(now, "DEFER", ["cancelled"], `${c.note}: the question was not spoken; it goes back to the queue.`, c, { deferTo: "next_pause" });
  }

  // -- Teach ----------------------------------------------------------------

  /** Teach, at a checkpoint: WARN when the draft is not clear (bypassing budget and cooldown), otherwise stay quiet. */
  decideCheckpoint(result: { status: "clear" | "warn" | "unknown"; evidenceIds: readonly string[] }, nowMs?: number): BrainDecision {
    const now = this.time(nowMs);
    const extra = { evidenceIds: [...result.evidenceIds], topic: "checkpoint" as const };
    if (this.mode !== "teach") return this.record(now, "SKIP", ["wrong_mode"], "Checkpoints belong to Teach.", null, extra);
    if (this.quiet.isOffRecord()) return this.record(now, "SKIP", ["off_record"], "Off the record: no coaching.", null, extra);
    if (result.status === "clear") return this.record(now, "SKIP", ["checkpoint_clear"], "The checkpoint is clear: nothing to add before Send.", null, extra);
    const q = this.quietNow(now);
    const speaking = !q.channels.human || !q.channels.agent;
    const why = result.status === "warn" ? "the draft breaks what the expert confirmed" : "the map cannot say what is right here";
    return this.record(
      now,
      "WARN",
      [result.status === "warn" ? "checkpoint_warn" : "checkpoint_unknown", "bypass_budget", "bypass_cooldown"],
      `Before Send: ${why}; stopping the new hire before it is saved.`,
      null,
      { ...extra, deliver: speaking ? "after_speech" : "now" },
    );
  }

  // -- Review ---------------------------------------------------------------

  /** Questions that were never asked live (budget used, no pause came): material for Review. Expired items are left out. */
  heldForReview(nowMs?: number): ReviewItem[] {
    const now = this.time(nowMs);
    const items: ReviewItem[] = [];
    for (const c of this.candidates) {
      if (c.state !== "review" || c.topic === null || c.heldAtMs === null || c.expiresAtMs === null) continue;
      if (now >= c.expiresAtMs) continue;
      items.push({ candidateId: c.id, topic: c.topic, entityRef: c.entityRef, evidenceIds: [...c.evidenceIds], note: c.note, heldAtMs: c.heldAtMs, expiresAtMs: c.expiresAtMs });
    }
    return items;
  }
}
