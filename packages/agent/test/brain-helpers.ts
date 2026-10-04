// Helpers for the brain tests (policy, map, review, tutor): fixture readers, canonical observation builders and a
// small driver that plays a Learn session through the policy, the extractor and the map on a fake clock.
// Only tests read the scripted actors (expert, novice) and the expected results; agent code never does.
import { readFileSync } from "node:fs";
import { SCHEMA_VERSION, parseActionCheckpoint, parseScreenObservation } from "@apprentice/contracts";
import type { ActionCheckpoint, EmailDraftFacts, OrderFacts, ScreenObservation } from "@apprentice/contracts";
import {
  ConversationPolicy,
  FakeClock,
  HeuristicAnswerExtractor,
  createMapState,
  planFollowUps,
  reduceMap,
  workingMap,
} from "../src/index.ts";
import type { AnswerExtractor, BrainDecision, MapState, PersonaId, Question, Topic } from "../src/index.ts";
import { must } from "./helpers.ts";

const root = new URL("../../../fixtures/agent/", import.meta.url);

export function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, root), "utf8"));
}

type Rec = Record<string, unknown>;
export function rec(u: unknown): Rec {
  if (typeof u !== "object" || u === null || Array.isArray(u)) throw new Error("expected an object");
  return u as Rec;
}
export function str(u: unknown): string {
  if (typeof u !== "string") throw new Error("expected a string");
  return u;
}
export function arr(u: unknown): unknown[] {
  if (!Array.isArray(u)) throw new Error("expected an array");
  return u;
}

// -- scripted actors and expected results -----------------------------------

export function order(orderId: string): OrderFacts {
  const found = arr(rec(readJson("sim/scenario.json")).orders)
    .map(rec)
    .find((o) => o.id === orderId);
  const o = must(found, `order ${orderId}`);
  return {
    customerRef: typeof o.customerRef === "string" ? o.customerRef : null,
    orderId: str(o.id),
    deliveryAddress: str(o.deliveryAddress),
    deliveryWindow: str(o.deliveryWindow),
  };
}

export function expertAnswer(topic: string): string {
  return str(rec(rec(rec(readJson("sim/expert-script.json")).answers)[topic]).text);
}

export function expertTeachback(kind: "correction" | "confirm"): string {
  return str(rec(rec(rec(readJson("sim/expert-script.json")).teachback)[kind]).text);
}

export function novicePredict(caseId: string): string {
  const c = arr(rec(readJson("sim/novice-script.json")).cases)
    .map(rec)
    .find((x) => x.case === caseId);
  return str(rec(must(c, `novice case ${caseId}`).predict).text);
}

export function expected(id: string): Rec {
  return rec(readJson(`expected/${id}.json`));
}

// -- canonical observations --------------------------------------------------

export class Feed {
  readonly sessionId: string;
  private seq: number;
  constructor(sessionId: string, firstSequence = 0) {
    this.sessionId = sessionId;
    this.seq = firstSequence;
  }

  private base(kind: ScreenObservation["kind"], timestampMs: number) {
    this.seq += 1;
    const n = String(this.seq).padStart(3, "0");
    const vision = kind !== "input_activity";
    return {
      schemaVersion: SCHEMA_VERSION,
      id: `${this.sessionId}-obs-${n}`,
      sessionId: this.sessionId,
      sequence: this.seq,
      timestampMs,
      source: vision ? "vision" : "workspace",
      frameId: vision ? `f-${n}` : null,
      sourceRevision: vision ? `rev-${this.sessionId}-${n}` : null,
      evidenceIds: vision ? [`ev-${this.sessionId}-${n}`] : [],
    };
  }

  order(timestampMs: number, facts: OrderFacts): ScreenObservation {
    return parseScreenObservation({ ...this.base("order_view", timestampMs), kind: "order_view", facts, entityRef: facts.customerRef });
  }

  email(timestampMs: number, customerRef: string | null, over: Partial<EmailDraftFacts> = {}): ScreenObservation {
    const facts: EmailDraftFacts = {
      recipientRef: customerRef ? `contact_${customerRef}` : null,
      subject: "Delivery details",
      bodyText: "",
      attachments: [],
      previewState: "editing",
      ...over,
    };
    return parseScreenObservation({ ...this.base("email_draft", timestampMs), kind: "email_draft", facts, entityRef: customerRef });
  }

  ticket(timestampMs: number, customerRef: string | null, status: "open" | "done"): ScreenObservation {
    const facts = { ticketId: "TCK-1", orderId: "ORD-2041", customerRef, status, summary: status === "done" ? "details sent" : "" };
    return parseScreenObservation({ ...this.base("ticket", timestampMs), kind: "ticket", facts, entityRef: customerRef });
  }

  typing(timestampMs: number, lastInputAtMs: number): ScreenObservation {
    const facts = { surface: "email", typing: timestampMs - lastInputAtMs < 2000, idleMs: timestampMs - lastInputAtMs, lastInputAtMs };
    return parseScreenObservation({ ...this.base("input_activity", timestampMs), kind: "input_activity", facts, entityRef: null });
  }
}

const IMAGE = { kind: "image" as const, ocrText: "order template" };

export interface LearnObservations {
  all: ScreenObservation[];
  start: ScreenObservation;
  attached: ScreenObservation;
  removal: ScreenObservation;
  body: ScreenObservation;
  preview: ScreenObservation;
}

export function bodyFor(o: OrderFacts, withId = false): string {
  const lines = ["Hello, here are your delivery details."];
  if (withId) lines.push(`Order: ${o.orderId}`);
  lines.push(`Address: ${o.deliveryAddress}`, `Delivery window: ${o.deliveryWindow}`);
  return lines.join("\n");
}

/** The Learn moves of the scripted expert on ORD-2041, as the screen would report them. */
export function learnObservations(sessionId = "sess-learn"): LearnObservations {
  const feed = new Feed(sessionId);
  const o = order("ORD-2041");
  const c = o.customerRef;
  const start = feed.email(0, c);
  const list = [feed.order(0, o), start];
  const attached = feed.email(2800, c, { attachments: [IMAGE] });
  const removal = feed.email(4600, c);
  const body = feed.email(17000, c, { bodyText: bodyFor(o) });
  const preview = feed.email(28000, c, { bodyText: bodyFor(o), previewState: "preview" });
  const sent = feed.email(40000, c, { bodyText: bodyFor(o), previewState: "sent" });
  list.push(attached, removal, body, preview, sent);
  return { all: list, start, attached, removal, body, preview };
}

// -- building a map without time -------------------------------------------

export interface BuildOptions {
  answers?: Topic[];
  followUps?: boolean;
  correction?: boolean;
  confirm?: boolean;
  extractor?: AnswerExtractor;
}

/** Scripted expert answers through the extractor into the reducer, the way a session would, but without a clock. */
export async function buildState(opts: BuildOptions = {}): Promise<MapState> {
  const extractor = opts.extractor ?? new HeuristicAnswerExtractor();
  const run = learnObservations();
  let state = createMapState();
  for (const ob of run.all) state = reduceMap(state, { type: "observation", observation: ob });
  const given = opts.answers ?? ["reason", "essentials", "guardrail", "scope", "exception", "why_stop", "duration"];
  const live: Array<[Topic, ScreenObservation]> = [
    ["reason", run.removal],
    ["essentials", run.body],
    ["guardrail", run.preview],
  ];
  let atMs = 10000;
  for (const [topic, ob] of live) {
    if (!given.includes(topic)) continue;
    const extraction = await extractor.extract({
      topic,
      text: expertAnswer(topic),
      questionId: `q-${topic}`,
      atMs: (atMs += 7000),
      evidenceIds: [...ob.evidenceIds],
      targetId: null,
      entityRef: "customer_07",
    });
    state = reduceMap(state, { type: "answer", extraction });
  }
  if (opts.followUps !== false) {
    for (const q of planFollowUps(workingMap(state))) {
      if (!given.includes(q.topic)) continue;
      const extraction = await extractor.extract({
        topic: q.topic,
        text: expertAnswer(q.topic),
        questionId: q.id,
        atMs: (atMs += 7000),
        evidenceIds: q.evidenceIds,
        targetId: q.targetId,
        entityRef: q.entityRef,
      });
      state = reduceMap(state, { type: "answer", extraction });
    }
  }
  if (opts.correction) {
    const extraction = await extractor.extract({
      topic: "correction",
      text: expertTeachback("correction"),
      questionId: null,
      atMs: (atMs += 7000),
      evidenceIds: [],
      targetId: null,
      entityRef: null,
    });
    state = reduceMap(state, { type: "correct", extraction });
  }
  if (opts.confirm !== false) state = reduceMap(state, { type: "confirm", atMs: (atMs += 7000), quote: expertTeachback("confirm") });
  return state;
}

// -- Teach cases -------------------------------------------------------------

export interface TeachCase {
  id: string;
  title: string;
  order: ScreenObservation;
  email: ScreenObservation;
  observations: ScreenObservation[];
  checkpoint: ActionCheckpoint;
}

/** A Teach case from fixtures/agent/teach/<id>.json as canonical observations plus the checkpoint raised at Preview. */
export function teachCase(id: string): TeachCase {
  const r = rec(readJson(`teach/${id}.json`));
  const d = rec(r.draft);
  const o = order(str(r.orderId));
  const feed = new Feed(`sess-teach-${id}`);
  const orderObs = feed.order(0, o);
  const emailObs = feed.email(3000, o.customerRef, {
    bodyText: str(d.bodyText),
    attachments: d.attachTemplateImage === true ? [{ kind: "image", ocrText: `Order ${o.orderId} | ${o.deliveryAddress}` }] : [],
    previewState: "preview",
  });
  const checkpoint = parseActionCheckpoint({
    schemaVersion: SCHEMA_VERSION,
    id: `${feed.sessionId}:cp-1`,
    sessionId: feed.sessionId,
    timestampMs: 3500,
    observationIds: [orderObs.id, emailObs.id],
    revisions: { order: must(orderObs.sourceRevision), email: must(emailObs.sourceRevision) },
    action: "send",
  });
  return { id, title: str(r.title), order: orderObs, email: emailObs, observations: [orderObs, emailObs], checkpoint };
}

// -- a Learn session on a fake clock ----------------------------------------

export interface LearnSession {
  policy: ConversationPolicy;
  clock: FakeClock;
  now: () => number;
  /** Advance session time, playing observations and the conversation. */
  run(ms: number): Promise<void>;
  state(): MapState;
  questions: Array<{ question: Question; askedAtMs: number }>;
  decisions(): BrainDecision[];
}

export interface LearnSessionOptions {
  persona?: PersonaId;
  budget?: number;
  /** Observations to play, with their session times. Default: the scripted Learn session. */
  timeline?: ScreenObservation[];
  /** Typing bursts as [fromMs, toMs]; heartbeats every second, then typing:false. */
  typing?: Array<[number, number]>;
  agentSpeakMs?: number;
  humanAnswerMs?: number;
  extractor?: AnswerExtractor;
}

export function startLearnSession(opts: LearnSessionOptions = {}): LearnSession {
  const epoch = 1_000_000;
  const clock = new FakeClock(epoch);
  const now = (): number => clock.now() - epoch;
  const policy = new ConversationPolicy({ mode: "learn", persona: opts.persona, budget: opts.budget, now });
  const extractor = opts.extractor ?? new HeuristicAnswerExtractor();
  let state = createMapState();
  const feed = new Feed("sess-learn", 100);
  const timeline: ScreenObservation[] = [...(opts.timeline ?? learnObservations().all)];
  for (const [from, to] of opts.typing ?? [[13000, 17000]]) {
    let last = from;
    for (let t = from; t <= to; t += 1000) {
      timeline.push(feed.typing(t, t));
      last = t;
    }
    timeline.push(feed.typing(last + 2000, last));
  }
  timeline.sort((a, b) => a.timestampMs - b.timestampMs);
  let next = 0;
  const questions: LearnSession["questions"] = [];
  let talk: { question: Question; phase: "agent" | "human"; agentEnd: number; humanEnd: number } | null = null;
  const agentMs = opts.agentSpeakMs ?? 2500;
  const humanMs = opts.humanAnswerMs ?? 3000;

  async function step(): Promise<void> {
    clock.advance(250);
    const t = now();
    while (next < timeline.length && must(timeline[next]).timestampMs <= t) {
      const ob = must(timeline[next++]);
      policy.observe(ob);
      state = reduceMap(state, { type: "observation", observation: ob });
    }
    if (talk !== null) {
      if (talk.phase === "agent" && t >= talk.agentEnd) {
        policy.agentSpeech(false);
        policy.humanSpeech(true, t);
        talk.phase = "human";
      } else if (talk.phase === "human" && t >= talk.humanEnd) {
        policy.humanSpeech(false, t);
        const q = talk.question;
        const extraction = await extractor.extract({
          topic: q.topic,
          text: expertAnswer(q.topic),
          questionId: q.id,
          atMs: t,
          evidenceIds: q.evidenceIds,
          targetId: q.targetId,
          entityRef: q.entityRef,
        });
        state = reduceMap(state, { type: "answer", extraction });
        policy.setMap(workingMap(state));
        policy.finishQuestion(q.id, t);
        talk = null;
      }
    }
    for (const d of policy.tick(t)) {
      if (d.decision === "ASK_NOW" && d.question !== null) {
        questions.push({ question: d.question, askedAtMs: t });
        policy.agentSpeech(true);
        talk = { question: d.question, phase: "agent", agentEnd: t + agentMs, humanEnd: t + agentMs + humanMs };
      }
    }
  }

  return {
    policy,
    clock,
    now,
    questions,
    state: () => state,
    decisions: () => policy.log,
    async run(ms: number) {
      const end = now() + ms;
      while (now() < end) await step();
    },
  };
}
