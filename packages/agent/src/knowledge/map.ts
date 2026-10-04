// Work Map reducer. Pure: reduceMap(state, event) returns a new, frozen state and never touches its input.
// Observations become steps, the expert's answers (already extracted, see extractor.ts) become decisions with the
// expert's own quote and evidence ids, and guardrails. Nothing is pre-written: a guardrail exists only because an
// answer created it, its reason is the expert's clause, and what an email must carry comes from what the expert said
// was essential plus what the screen showed.
//
// Versions: the working draft has a version number. A correction seals the draft as an immutable "superseded"
// version and opens the next number; a confirmation seals the draft as an immutable "confirmed" version. A confirmed
// version is refused unless every item it confirms has at least one evidence id and one quote.
import type { EmailDraftFacts, OrderFacts, ScreenObservation } from "@apprentice/contracts";
import { extractionIssues } from "./extractor.ts";
import type { AnswerExtraction } from "./extractor.ts";
import { factsPresentIn } from "./facts.ts";
import { FACT_KEYS, deepFreeze, labelFacts } from "./types.ts";
import type {
  AnswerRecord,
  DeepReadonly,
  FactKey,
  MapGuardrailData,
  MapStepData,
  Topic,
  WorkMap,
  WorkMapData,
} from "./types.ts";

// ---------------------------------------------------------------------------
// State and events
// ---------------------------------------------------------------------------

interface GuardrailExtra {
  /** Facts the expert named as essential, or null when not asked or not said. */
  essential: FactKey[] | null;
  /** Facts the expert did not name but the screen showed typed for this customer, fixed the first time they were needed. */
  inferred: FactKey[] | null;
  /** Facts added by a correction. */
  corrected: FactKey[];
  /** A guardrail that copies another one's requirements (a similar request the expert could not explain). */
  copyOf: string | null;
}

interface DraftData {
  /** The number the working draft will carry when it is sealed. */
  version: number;
  /** The highest version number already sealed, or null. */
  sealedVersion: number | null;
  /** The draft changed since the last seal. */
  dirty: boolean;
  steps: MapStepData[];
  guardrails: MapGuardrailData[];
  extras: Record<string, GuardrailExtra>;
  answered: AnswerRecord[];
  stepSeq: number;
  guardrailSeq: number;
  order: OrderFacts | null;
  prevEmail: EmailDraftFacts | null;
  /** Facts typed into the message for the order now open. */
  observedBodyFacts: FactKey[];
  bodyStepId: string | null;
  /** Customer refs seen on screen, in the order they appeared. */
  customers: string[];
  /** Per customer: the facts the expert typed into a message. Never reset when the next order opens. */
  typedFacts: Record<string, FactKey[]>;
}

export interface MapState {
  readonly draft: DeepReadonly<DraftData>;
  /** Sealed versions, oldest first. Immutable. */
  readonly versions: readonly WorkMap[];
  /**
   * The digest of the teach-back last stated to the expert (see stateTeachBack), or null. It is set only by a `teachback_stated`
   * event and cleared by any event that changes what the working map says, so a confirmation can only refer to what the expert
   * was last told: a correction or a late answer makes a new version, and a "yes" before the new teach-back is stated is stale.
   */
  readonly lastStatedDigest: string | null;
}

export type MapEvent =
  | { type: "observation"; observation: ScreenObservation }
  | { type: "answer"; extraction: AnswerExtraction }
  /** The expert corrects the teach-back; the extraction is of their reply. */
  | { type: "correct"; extraction: AnswerExtraction }
  /** The expert confirms the teach-back. quote is their reply, when there is one. */
  /**
   * The expert confirms a teach-back. `stated` is the digest of the teach-back they heard: the confirmation is refused unless it
   * equals `state.lastStatedDigest` and the digest of the version being confirmed. Use confirmationOf(state, ...).
   */
  | { type: "confirm"; atMs: number; quote: string | null; stated: string }
  /** A teach-back was spoken to the expert (stateTeachBack). It counts only while it is still what the working map says. */
  | { type: "teachback_stated"; digest: string }
  /** Customers the workspace or the scenario lists, beyond those seen on screen: what a spoken customer can be resolved to. */
  | { type: "known_customers"; refs: readonly string[] };

export class MapValidationError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(`${message}: ${issues.join("; ")}`);
    this.name = "MapValidationError";
    this.issues = issues;
  }
}

export interface ConfirmIssue {
  kind: "guardrail" | "step";
  id: string;
  missing: Array<"evidence" | "quote">;
}

export class MapConfirmationError extends MapValidationError {
  readonly confirmIssues: ConfirmIssue[];
  constructor(confirmIssues: ConfirmIssue[]) {
    super(
      "Cannot confirm the map",
      confirmIssues.map((i) => `${i.kind} ${i.id} lacks ${i.missing.join(" and ")}`),
    );
    this.name = "MapConfirmationError";
    this.confirmIssues = confirmIssues;
  }
}

export function createMapState(knownCustomers: readonly string[] = []): MapState {
  const draft: DraftData = {
    version: 1,
    sealedVersion: null,
    dirty: false,
    steps: [],
    guardrails: [],
    extras: {},
    answered: [],
    stepSeq: 0,
    guardrailSeq: 0,
    order: null,
    prevEmail: null,
    observedBodyFacts: [],
    bodyStepId: null,
    customers: [...new Set(knownCustomers)],
    typedFacts: {},
  };
  return deepFreeze({ draft, versions: [] as WorkMap[], lastStatedDigest: null });
}

// ---------------------------------------------------------------------------
// Steps from observations
// ---------------------------------------------------------------------------

const UNKNOWN_ENTITY_CUE = /\b(can't|cannot|don't|do not|not) (tell|know|sure|identify|match)\b|\bunknown\b|\bunfamiliar\b/i;

function addStep(
  d: DraftData,
  partial: Pick<MapStepData, "goal" | "action" | "atMs" | "evidenceIds"> & { kind?: MapStepData["kind"] },
): MapStepData {
  const step: MapStepData = {
    id: `step-${++d.stepSeq}`,
    kind: partial.kind ?? "action",
    goal: partial.goal,
    action: partial.action,
    status: "observed",
    atMs: partial.atMs,
    evidenceIds: [...partial.evidenceIds],
    decision: null,
    guardrailIds: [],
  };
  d.steps.push(step);
  return step;
}

function reduceObservation(d: DraftData, obs: ScreenObservation): void {
  if (obs.kind === "input_activity") return;
  if (obs.kind === "order_view") {
    const f = obs.facts;
    const same = d.order !== null && d.order.orderId === f.orderId && d.order.customerRef === f.customerRef;
    d.order = f;
    if (f.customerRef !== null && !d.customers.includes(f.customerRef)) d.customers.push(f.customerRef);
    if (same) return;
    d.prevEmail = null;
    d.observedBodyFacts = [];
    d.bodyStepId = null;
    addStep(d, {
      goal: "Read the order essentials",
      action: `Opened order ${f.orderId ?? "(unreadable)"} for ${f.customerRef ?? "a customer that is not on the list"}`,
      atMs: obs.timestampMs,
      evidenceIds: obs.evidenceIds,
    });
    return;
  }
  if (obs.kind === "ticket") {
    const t = obs.facts;
    const opened = `Opened ticket ${t.ticketId}`;
    if (t.status === "done") {
      const done = `Marked ticket ${t.ticketId} done`;
      if (!d.steps.some((s) => s.action.startsWith(done))) {
        addStep(d, {
          goal: "Record the work",
          action: `${done}${t.summary ? ` with the note "${t.summary}"` : ""}`,
          atMs: obs.timestampMs,
          evidenceIds: obs.evidenceIds,
        });
      }
    } else if (!d.steps.some((s) => s.action.startsWith(opened))) {
      addStep(d, { goal: "Record the work", action: opened, atMs: obs.timestampMs, evidenceIds: obs.evidenceIds });
    }
    return;
  }

  const email = obs.facts;
  const prev = d.prevEmail;
  d.prevEmail = email;
  const goal = "Tell the customer the delivery details";
  if (prev === null) {
    addStep(d, { goal, action: "Started an email to the customer", atMs: obs.timestampMs, evidenceIds: obs.evidenceIds });
    return;
  }
  if (email.attachments.length > prev.attachments.length) {
    addStep(d, { goal, action: "Attached the order template image", atMs: obs.timestampMs, evidenceIds: obs.evidenceIds });
  } else if (email.attachments.length < prev.attachments.length) {
    const s = addStep(d, {
      goal: "Decide how to deliver the details",
      action: "Removed the image attachment",
      atMs: obs.timestampMs,
      evidenceIds: obs.evidenceIds,
      kind: "judgment",
    });
    s.decision = { summary: "Dropped the template image", reason: null, quote: null, evidenceIds: [...obs.evidenceIds] };
  }
  if (d.order !== null) {
    const found = factsPresentIn(email.bodyText, d.order);
    const before = d.observedBodyFacts.length;
    for (const f of found) if (!d.observedBodyFacts.includes(f)) d.observedBodyFacts.push(f);
    const who = d.order.customerRef;
    if (who !== null) {
      const typed = (d.typedFacts[who] ??= []);
      for (const f of found) if (!typed.includes(f)) typed.push(f);
    }
    if (found.length > 0 && (d.observedBodyFacts.length > before || d.bodyStepId === null)) {
      const action = `Wrote the ${labelFacts(FACT_KEYS.filter((k) => d.observedBodyFacts.includes(k)))} into the message`;
      const existing = d.steps.find((s) => s.id === d.bodyStepId);
      if (existing) {
        existing.action = action;
        for (const id of obs.evidenceIds) if (!existing.evidenceIds.includes(id)) existing.evidenceIds.push(id);
      } else {
        const s = addStep(d, {
          goal: "Decide how to deliver the details",
          action,
          atMs: obs.timestampMs,
          evidenceIds: obs.evidenceIds,
          kind: "judgment",
        });
        s.decision = { summary: "Typed order details into the message", reason: null, quote: null, evidenceIds: [...obs.evidenceIds] };
        d.bodyStepId = s.id;
      }
    }
  }
  if (prev.previewState !== "preview" && email.previewState === "preview") {
    addStep(d, { goal: "Check before sending", action: "Opened Preview before Send", atMs: obs.timestampMs, evidenceIds: obs.evidenceIds });
  }
  if (prev.previewState !== "sent" && email.previewState === "sent") {
    addStep(d, { goal, action: "Sent the email", atMs: obs.timestampMs, evidenceIds: obs.evidenceIds });
  }
}

// ---------------------------------------------------------------------------
// Guardrails from answers
// ---------------------------------------------------------------------------

function createGuardrail(
  d: DraftData,
  init: {
    trigger: MapGuardrailData["trigger"];
    condition: string;
    scope: MapGuardrailData["scope"];
    escalateTo: string | null;
    unexplained: boolean;
    essential: FactKey[] | null;
    copyOf: string | null;
  },
): MapGuardrailData {
  const g: MapGuardrailData = {
    id: `g${++d.guardrailSeq}`,
    trigger: init.trigger,
    condition: init.condition,
    requiredAction: "",
    requiredFacts: [],
    assumedFacts: [],
    scope: init.scope,
    exceptions: [],
    unknowns: [],
    reason: null,
    reasonUnknown: false,
    quote: null,
    quoteAtMs: null,
    quotes: [],
    scopeQuote: null,
    escalateTo: init.escalateTo,
    duration: null,
    status: "proposed",
    unexplained: init.unexplained,
    evidenceIds: [],
  };
  d.guardrails.push(g);
  d.extras[g.id] = { essential: init.essential, inferred: null, corrected: [], copyOf: init.copyOf };
  return g;
}

function customerGuardrail(d: DraftData, entityRef: string | null): MapGuardrailData {
  const found = d.guardrails.find(
    (g) => g.trigger === "customer" && !g.unexplained && (entityRef === null || g.scope.customers.includes(entityRef)),
  );
  if (found) return found;
  return createGuardrail(d, {
    trigger: "customer",
    condition: "",
    scope: { kind: "customers", customers: entityRef ? [entityRef] : [], explicit: false },
    escalateTo: null,
    unexplained: false,
    essential: null,
    copyOf: null,
  });
}

function targetGuardrail(d: DraftData, x: AnswerExtraction): MapGuardrailData {
  const byId = x.targetId !== null ? d.guardrails.find((g) => g.id === x.targetId) : undefined;
  return byId ?? customerGuardrail(d, x.entityRef);
}

function addEvidence(g: MapGuardrailData, ids: readonly string[]): void {
  for (const id of ids) if (!g.evidenceIds.includes(id)) g.evidenceIds.push(id);
}

function setQuote(g: MapGuardrailData, quote: string, atMs: number, replace: boolean): void {
  if (replace || g.quote === null) {
    g.quote = quote;
    g.quoteAtMs = atMs;
  }
}

function findStep(d: DraftData, x: AnswerExtraction): MapStepData | undefined {
  return d.steps.find((s) => s.evidenceIds.some((id) => x.evidenceIds.includes(id)));
}

/** The step an answer is about becomes a judgment call carrying the expert's quote. */
function decide(d: DraftData, x: AnswerExtraction, summary: string): void {
  const step = findStep(d, x);
  if (!step) return;
  step.kind = "judgment";
  step.status = "inferred";
  step.decision = {
    summary: step.decision?.summary ?? summary,
    reason: x.rationale ?? step.decision?.reason ?? null,
    quote: x.reasonQuote ?? x.quote,
    evidenceIds: unique([...(step.decision?.evidenceIds ?? []), ...x.evidenceIds]),
  };
}

function link(d: DraftData, x: AnswerExtraction, g: MapGuardrailData): void {
  const step = findStep(d, x);
  if (step && !step.guardrailIds.includes(g.id)) step.guardrailIds.push(g.id);
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function reduceAnswer(d: DraftData, x: AnswerExtraction): void {
  const issues = extractionIssues(x);
  if (issues.length > 0) throw new MapValidationError("Unusable answer extraction", issues);
  if (x.topic === "correction") throw new MapValidationError("Unusable answer extraction", ["a correction is a correct event"]);
  const topic: Topic = x.topic;
  d.answered.push({
    topic,
    entityRef: x.entityRef,
    questionId: x.questionId,
    targetId: x.targetId,
    atMs: x.atMs,
    evidenceIds: [...x.evidenceIds],
  });

  switch (topic) {
    case "reason": {
      const g = targetGuardrail(d, x);
      if (x.rationale !== null) {
        g.reason = x.rationale;
        g.reasonUnknown = false;
        setQuote(g, x.reasonQuote ?? x.quote, x.atMs, true);
      } else {
        setQuote(g, x.quote, x.atMs, false);
        if (x.reasonUnknown) g.reasonUnknown = true;
      }
      g.quotes.push(x.quote);
      for (const u of x.unknowns) if (!g.unknowns.includes(u)) g.unknowns.push(u);
      addEvidence(g, x.evidenceIds);
      decide(d, x, "Chose how to deliver the details");
      link(d, x, g);
      break;
    }
    case "essentials": {
      const g = customerGuardrail(d, x.entityRef);
      const extra = d.extras[g.id];
      if (extra && x.requiredFacts.length > 0) extra.essential = x.requiredFacts;
      setQuote(g, x.quote, x.atMs, false);
      g.quotes.push(x.quote);
      addEvidence(g, x.evidenceIds);
      decide(d, x, "Chose which details to write out");
      link(d, x, g);
      break;
    }
    case "guardrail": {
      const cond = x.stopCondition;
      if (cond !== null) {
        const trigger = UNKNOWN_ENTITY_CUE.test(cond) ? "unknown_entity" : "stop_condition";
        const existing = d.guardrails.find((g) => g.trigger === trigger && g.condition.toLowerCase() === cond.toLowerCase());
        const g =
          existing ??
          createGuardrail(d, {
            trigger,
            condition: cond,
            scope: { kind: "all", customers: [], explicit: true },
            escalateTo: x.escalateTo,
            unexplained: false,
            essential: null,
            copyOf: null,
          });
        setQuote(g, x.quote, x.atMs, true);
        g.quotes.push(x.quote);
        if (x.rationale !== null) g.reason = x.rationale;
        addEvidence(g, x.evidenceIds);
        link(d, x, g);
      }
      decide(d, x, "Named a reason to stop before Send");
      break;
    }
    case "scope": {
      const g = targetGuardrail(d, x);
      if (x.scope.explicit) {
        const named = x.scope.customers.filter((c) => !x.unexplainedCustomers.some((u) => u.customerRef === c));
        g.scope = x.scope.all
          ? { kind: "all", customers: [], explicit: true }
          : { kind: "customers", customers: unique([...g.scope.customers, ...named]), explicit: true };
        g.scopeQuote = x.scopeQuote ?? x.quote;
      }
      g.quotes.push(x.quote);
      for (const u of x.unexplainedCustomers) {
        if (d.guardrails.some((o) => o.unexplained && o.scope.customers.includes(u.customerRef))) continue;
        const copy = createGuardrail(d, {
          trigger: "customer",
          condition: "",
          scope: { kind: "customers", customers: [u.customerRef], explicit: true },
          escalateTo: null,
          unexplained: true,
          essential: null,
          copyOf: g.id,
        });
        setQuote(copy, u.quote, x.atMs, true);
        copy.quotes.push(u.quote);
      }
      break;
    }
    case "exception": {
      const g = targetGuardrail(d, x);
      for (const e of x.exceptions) g.exceptions.push({ text: e.text, quote: e.quote });
      g.quotes.push(x.quote);
      break;
    }
    case "why_stop": {
      // The guardrail keeps the expert's statement of the rule as its quote; the reason is added beside it.
      const g = targetGuardrail(d, x);
      if (x.rationale !== null) {
        g.reason = x.rationale;
        g.reasonUnknown = false;
        setQuote(g, x.reasonQuote ?? x.quote, x.atMs, false);
      } else if (x.reasonUnknown) {
        g.reasonUnknown = true;
      }
      g.quotes.push(x.quote);
      break;
    }
    case "duration": {
      const g = targetGuardrail(d, x);
      g.duration = x.text;
      g.quotes.push(x.quote);
      break;
    }
    case "ticket_note":
      decide(d, x, "Chose what to note in the ticket");
      break;
  }
  if (x.retracts && topic !== "ticket_note") targetGuardrail(d, x).status = "conflicted";
  freezeInferred(d);
}

function reduceCorrection(d: DraftData, x: AnswerExtraction): void {
  const targets =
    x.targetId !== null
      ? d.guardrails.filter((g) => g.id === x.targetId)
      : d.guardrails.filter((g) => g.trigger === "customer" && !g.unexplained);
  for (const g of targets) {
    const extra = d.extras[g.id];
    if (extra) for (const f of x.requiredFacts) if (!extra.corrected.includes(f)) extra.corrected.push(f);
    if (x.scope.all && x.scope.explicit) {
      g.scope = { kind: "all", customers: [], explicit: true };
      g.scopeQuote = x.scopeQuote ?? x.quote;
    } else if (x.scope.customers.length > 0 && g.scope.kind === "customers") {
      // "Customer twelve too": the expert puts more customers into the rule's scope.
      g.scope = { kind: "customers", customers: unique([...g.scope.customers, ...x.scope.customers]), explicit: true };
      g.scopeQuote = x.scopeQuote ?? x.quote;
    }
    if (x.rationale !== null) {
      g.reason = x.rationale;
      g.reasonUnknown = false;
      setQuote(g, x.reasonQuote ?? x.quote, x.atMs, true);
    }
    g.quotes.push(x.quote);
    if (x.retracts) g.status = "conflicted";
    else if (g.status === "confirmed") g.status = "proposed";
  }
}

// ---------------------------------------------------------------------------
// Snapshots, validation, sealing
// ---------------------------------------------------------------------------

/** The facts the expert typed into messages for the customers a guardrail covers, in canonical order. */
function typedFor(d: DraftData, g: MapGuardrailData): FactKey[] {
  const refs = g.scope.kind === "all" ? Object.keys(d.typedFacts) : g.scope.customers;
  const all = new Set<FactKey>(refs.flatMap((c) => d.typedFacts[c] ?? []));
  return FACT_KEYS.filter((f) => all.has(f));
}

/**
 * What the message must carry: what the expert named as essential; else what the screen showed them typing for this
 * customer, fixed the first time it was needed (so the next order cannot change the rule); plus later corrections.
 */
function requiredFactsFor(d: DraftData, g: MapGuardrailData): FactKey[] {
  const extra = d.extras[g.id];
  if (!extra) return [];
  const originGuardrail = extra.copyOf !== null ? d.guardrails.find((x) => x.id === extra.copyOf) : g;
  const origin = extra.copyOf !== null ? d.extras[extra.copyOf] : extra;
  const base = origin?.essential ?? origin?.inferred ?? (originGuardrail ? typedFor(d, originGuardrail) : []);
  const all = new Set<FactKey>([...base, ...(origin?.corrected ?? []), ...extra.corrected]);
  return FACT_KEYS.filter((f) => all.has(f));
}

/** The part of the required facts nobody told the map (neither the essentials answer nor a correction): assumed from the screen. */
function assumedFactsFor(d: DraftData, g: MapGuardrailData, required: readonly FactKey[]): FactKey[] {
  const extra = d.extras[g.id];
  if (!extra) return [];
  const origin = extra.copyOf !== null ? d.extras[extra.copyOf] : extra;
  const said = new Set<FactKey>([...(origin?.essential ?? []), ...(origin?.corrected ?? []), ...extra.corrected]);
  return required.filter((f) => !said.has(f));
}

/** Fixes the inferred required facts of every customer rule the expert did not name, once the screen has shown some. */
function freezeInferred(d: DraftData): void {
  for (const g of d.guardrails) {
    const extra = d.extras[g.id];
    if (!extra || g.trigger !== "customer" || g.unexplained || extra.copyOf !== null) continue;
    if (extra.essential !== null || extra.inferred !== null) continue;
    const facts = typedFor(d, g);
    if (facts.length > 0) extra.inferred = facts;
  }
}

function projectGuardrail(d: DraftData, g: MapGuardrailData): MapGuardrailData {
  const copy = structuredClone(g);
  if (g.trigger === "customer") {
    copy.requiredFacts = requiredFactsFor(d, g);
    copy.assumedFacts = assumedFactsFor(d, g, copy.requiredFacts);
    copy.requiredAction =
      copy.requiredFacts.length > 0
        ? `Include the ${labelFacts(copy.requiredFacts)} in the email you send`
        : "Unknown: the expert has not said what the email must contain";
    const who = g.scope.kind === "all" ? "any order" : `an order of ${g.scope.customers.join(", ") || "the observed customer"}`;
    copy.condition = `Sending the delivery email for ${who}`;
  } else {
    copy.condition = `The expert's trigger: "${g.condition}"`;
    copy.requiredAction = `Stop and ask ${g.escalateTo ?? "someone"} before sending`;
  }
  const unknowns = [...g.unknowns];
  const add = (u: string): void => {
    if (!unknowns.includes(u)) unknowns.push(u);
  };
  if (g.unexplained) add("The expert does not know why; treated as a habit, not a rule.");
  else if (g.reason === null) add(g.reasonUnknown ? "The expert does not know why." : "The reason was not explained.");
  if (g.trigger === "customer" && !g.unexplained) {
    if (!g.scope.explicit) add(`Scope not stated; defaults to ${g.scope.customers.join(", ") || "the observed customer"}.`);
    if (copy.requiredFacts.length === 0) add("What the email must contain was not said.");
  }
  copy.unknowns = unknowns;
  return copy;
}

function project(d: DraftData, version: number, status: WorkMapData["status"], sealed: { atMs: number; quote: string | null; stated?: string } | null): WorkMapData {
  const guardrails = d.guardrails.map((g) => projectGuardrail(d, g));
  return {
    version,
    status,
    confirmed: status === "confirmed",
    sealedAtMs: sealed?.atMs ?? null,
    confirmation: status === "confirmed" && sealed ? { quote: sealed.quote, atMs: sealed.atMs, statedDigest: sealed.stated ?? "" } : null,
    steps: structuredClone(d.steps),
    guardrails,
    unknowns: guardrails.flatMap((g) => g.unknowns.map((u) => `${g.id}: ${u}`)),
    answered: structuredClone(d.answered),
  };
}

const eligible = (g: MapGuardrailData): boolean => g.status !== "conflicted" && !g.unexplained && g.reason !== null;

function missingOf(evidenceIds: readonly string[], quote: string | null): ConfirmIssue["missing"] {
  const missing: ConfirmIssue["missing"] = [];
  if (evidenceIds.length === 0) missing.push("evidence");
  if (quote === null || quote.trim().length === 0) missing.push("quote");
  return missing;
}

function draftConfirmIssues(d: DraftData): ConfirmIssue[] {
  const issues: ConfirmIssue[] = [];
  for (const g of d.guardrails) {
    if (!eligible(g)) continue;
    const missing = missingOf(g.evidenceIds, g.quote);
    if (missing.length > 0) issues.push({ kind: "guardrail", id: g.id, missing });
  }
  for (const s of d.steps) {
    if (s.decision === null || s.status !== "inferred") continue;
    const missing = missingOf(s.decision.evidenceIds, s.decision.quote);
    if (missing.length > 0) issues.push({ kind: "step", id: s.id, missing });
  }
  return issues;
}

/** What would stop the working draft from being confirmed right now. Empty means it can be confirmed. */
export function confirmIssues(state: MapState): ConfirmIssue[] {
  return draftConfirmIssues(structuredClone(state.draft) as DraftData);
}

/** Problems in a map as a reader would see it: a confirmed item without evidence or a quote, duplicate ids. */
export function validateWorkMap(map: WorkMap): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const item of [...map.steps, ...map.guardrails]) {
    if (ids.has(item.id)) problems.push(`duplicate id ${item.id}`);
    ids.add(item.id);
  }
  if (map.confirmed) {
    // The confirmation must state exactly this version: a map whose teach-back digest does not match is not a confirmed one.
    if (map.confirmation === null || map.confirmation.statedDigest !== teachBackDigest(map)) {
      problems.push("the confirmation does not state this version of the map");
    }
    for (const g of map.guardrails) {
      if (g.status !== "confirmed") continue;
      const missing = missingOf(g.evidenceIds, g.quote);
      if (missing.length > 0) problems.push(`confirmed guardrail ${g.id} lacks ${missing.join(" and ")}`);
    }
    for (const s of map.steps) {
      if (s.status !== "confirmed" || s.decision === null) continue;
      const missing = missingOf(s.decision.evidenceIds, s.decision.quote);
      if (missing.length > 0) problems.push(`confirmed step ${s.id} lacks ${missing.join(" and ")}`);
    }
  }
  return problems;
}

function seal(d: DraftData, status: "superseded" | "confirmed", atMs: number, quote: string | null, stated?: string): WorkMap {
  freezeInferred(d);
  const sealed = deepFreeze(project(d, d.version, status, { atMs, quote, ...(stated !== undefined ? { stated } : {}) }));
  d.sealedVersion = d.version;
  d.dirty = false;
  return sealed;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function fingerprint(d: DraftData): string {
  return JSON.stringify([d.steps, d.guardrails, d.answered, d.extras, d.typedFacts, d.customers]);
}

export function reduceMap(state: MapState, event: MapEvent): MapState {
  if (event.type === "teachback_stated") {
    // It counts only for what the working map says now; a teach-back of an older version states nothing.
    const digest = teachBackDigest(workingMap(state));
    return event.digest === digest && state.lastStatedDigest !== digest ? deepFreeze({ draft: state.draft, versions: state.versions, lastStatedDigest: digest }) : state;
  }
  const next = reduceDraft(state, event);
  // Whatever changes what the working map says (a correction, a late answer, a new fact on screen) un-states the teach-back.
  if (next.lastStatedDigest !== null && next.lastStatedDigest !== teachBackDigest(workingMap(next))) {
    return deepFreeze({ draft: next.draft, versions: next.versions, lastStatedDigest: null });
  }
  return next;
}

function reduceDraft(state: MapState, event: Exclude<MapEvent, { type: "teachback_stated" }>): MapState {
  const d = structuredClone(state.draft) as DraftData;
  let versions: readonly WorkMap[] = state.versions;
  switch (event.type) {
    case "observation": {
      const before = fingerprint(d);
      reduceObservation(d, event.observation);
      if (fingerprint(d) !== before) d.dirty = true;
      break;
    }
    case "answer": {
      reduceAnswer(d, event.extraction);
      d.dirty = true;
      break;
    }
    case "correct": {
      const sealed = reduceCorrectionEvent(d, event.extraction);
      if (sealed !== null) versions = [...versions, sealed];
      break;
    }
    case "known_customers": {
      for (const ref of event.refs) if (!d.customers.includes(ref)) d.customers.push(ref);
      break;
    }
    case "confirm": {
      const issues = draftConfirmIssues(d);
      if (issues.length > 0) throw new MapConfirmationError(issues);
      if (!d.dirty && d.sealedVersion === d.version) return state;
      if (d.sealedVersion === d.version) d.version += 1;
      // The gate: only the version the expert was last told, exactly, can be confirmed.
      const heard = teachBackDigest(deepFreeze(project(d, d.version, "draft", null)));
      if (state.lastStatedDigest === null) throw new MapValidationError("Cannot confirm", ["no teach-back of this version was stated to the expert"]);
      if (event.stated !== state.lastStatedDigest || event.stated !== heard) {
        throw new MapValidationError("Cannot confirm", ["the confirmation does not state this version of the map (it changed since the teach-back)"]);
      }
      for (const g of d.guardrails) if (eligible(g)) g.status = "confirmed";
      for (const s of d.steps) if (s.decision !== null && s.status === "inferred") s.status = "confirmed";
      versions = [...versions, seal(d, "confirmed", event.atMs, event.quote, event.stated)];
      break;
    }
  }
  return deepFreeze({ draft: d, versions, lastStatedDigest: state.lastStatedDigest });
}

/** Seals the pre-correction draft as "superseded" (unless it is already sealed) and applies the correction to the next version. */
function reduceCorrectionEvent(d: DraftData, x: AnswerExtraction): WorkMap | null {
  // Validate before sealing so a refused correction leaves the version history untouched.
  const issues = extractionIssues(x);
  if (issues.length > 0) throw new MapValidationError("Unusable answer extraction", issues);
  const sealed = d.sealedVersion !== d.version ? seal(d, "superseded", x.atMs, null) : null;
  d.version += 1;
  reduceCorrection(d, x);
  d.dirty = true;
  return sealed;
}

// ---------------------------------------------------------------------------
// Reading a state
// ---------------------------------------------------------------------------

/** Customer refs seen on screen so far, plus the customer list given to the map: what a spoken "customer seven" can be mapped onto. */
export function knownCustomerRefs(state: MapState): string[] {
  return [...state.draft.customers];
}

/** The working draft as a map (status "draft"). It is what the teach-back describes. */
export function workingMap(state: MapState): WorkMap {
  const d = structuredClone(state.draft) as DraftData;
  // A draft that changed after a seal is the next version already: the teach-back states that number.
  const version = d.sealedVersion === d.version && d.dirty ? d.version + 1 : d.version;
  return deepFreeze(project(d, version, "draft", null));
}

/** FNV-1a, 32 bit: a short fingerprint, not a security feature. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The fingerprint of what a teach-back STATES: the version and, for every guardrail, its scope, the fields required, the
 * exceptions and the reason (or that it is unknown). Two maps with the same digest say the same thing to the expert.
 */
export function teachBackDigest(map: WorkMap): string {
  const stated = {
    version: map.version,
    guardrails: map.guardrails.map((g) => ({
      id: g.id,
      trigger: g.trigger,
      unexplained: g.unexplained,
      scope: { kind: g.scope.kind, customers: [...g.scope.customers].sort(), explicit: g.scope.explicit },
      fields: [...g.requiredFacts],
      assumed: [...g.assumedFacts],
      exceptions: g.exceptions.map((e) => e.text),
      reason: g.reason,
      escalateTo: g.escalateTo,
      condition: g.trigger === "customer" ? null : g.condition,
    })),
  };
  return fnv1a(JSON.stringify(stated));
}

/**
 * The confirmation event for the teach-back last stated to the expert (state.lastStatedDigest). Without one, or after the map
 * changed, reduceMap refuses it: a confirmation is never matched against the current version, only against what was said.
 */
export function confirmationOf(state: MapState, atMs: number, quote: string | null): MapEvent {
  return { type: "confirm", atMs, quote, stated: state.lastStatedDigest ?? "" };
}

/** The latest version the expert confirmed, or null. This is the only version Teach may apply. */
export function latestConfirmed(state: MapState): WorkMap | null {
  for (let i = state.versions.length - 1; i >= 0; i--) {
    const v = state.versions[i];
    if (v?.confirmed) return v;
  }
  return null;
}

export function replayMap(events: readonly MapEvent[]): MapState {
  return events.reduce(reduceMap, createMapState());
}
