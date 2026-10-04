// Shared types of the knowledge layer: facts, topics, questions and the Work Map.
// Screen types (observations, checkpoints) come from @apprentice/contracts and are never redefined here.

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Recursively freezes a value so a published map version cannot be changed afterwards. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Fields of the order that an email can be required to carry. */
export const FACT_KEYS = ["orderId", "deliveryAddress", "deliveryWindow"] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export const FACT_LABELS: Readonly<Record<FactKey, string>> = {
  orderId: "order number",
  deliveryAddress: "delivery address",
  deliveryWindow: "delivery window",
};

/** "a", "a and b", "a, b and c". */
export function labelFacts(facts: readonly FactKey[]): string {
  const labels = facts.map((f) => FACT_LABELS[f]);
  if (labels.length < 2) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** What a question is about. Learn asks reason, essentials and guardrail; Review asks the rest. */
export const TOPICS = [
  "reason",
  "essentials",
  "guardrail",
  "scope",
  "exception",
  "why_stop",
  "duration",
  "ticket_note",
] as const;
export type Topic = (typeof TOPICS)[number];

export interface Question {
  id: string;
  topic: Topic;
  text: string;
  /** The screen moments the question is about; never empty for a Learn question. */
  evidenceIds: string[];
  /** The guardrail a Review follow-up extends, or null. */
  targetId: string | null;
  /** The customer the question concerns, e.g. customer_07. */
  entityRef: string | null;
}

// ---------------------------------------------------------------------------
// Work Map
// ---------------------------------------------------------------------------

export type MapStepKind = "action" | "judgment";
export type MapStepStatus = "observed" | "inferred" | "confirmed";

export interface MapDecisionData {
  summary: string;
  /** The expert's reason in their own clause, or null while unexplained. */
  reason: string | null;
  /** The expert's sentence that carries the decision. */
  quote: string | null;
  /** The screen moments the decision was made at. */
  evidenceIds: string[];
}

export interface MapStepData {
  id: string;
  kind: MapStepKind;
  goal: string;
  action: string;
  status: MapStepStatus;
  atMs: number;
  /** Screen moments that show the step. */
  evidenceIds: string[];
  decision: MapDecisionData | null;
  guardrailIds: string[];
}

export interface MapExceptionData {
  text: string;
  quote: string;
}

export interface MapScopeData {
  kind: "customers" | "all";
  customers: string[];
  /** True when the expert stated the scope; false when it defaults to the customer named on screen. */
  explicit: boolean;
}

/**
 * customer: applies to the scoped customers.
 * unknown_entity: applies when the customer is not recognised.
 * stop_condition: any other stop-and-ask condition; recorded on the map, not machine-checked.
 */
export type MapGuardrailTrigger = "customer" | "unknown_entity" | "stop_condition";
export type MapGuardrailStatus = "proposed" | "confirmed" | "conflicted";

export interface MapGuardrailData {
  id: string;
  trigger: MapGuardrailTrigger;
  condition: string;
  requiredAction: string;
  requiredFacts: FactKey[];
  scope: MapScopeData;
  exceptions: MapExceptionData[];
  /** Open points kept as unknown instead of being guessed. */
  unknowns: string[];
  reason: string | null;
  /** The expert was asked why and said they do not know. Not asked again. */
  reasonUnknown: boolean;
  /** The expert's own words that carry the reason (or, without one, the statement of the rule). */
  quote: string | null;
  quoteAtMs: number | null;
  quotes: string[];
  /** The expert's words that limit or widen the scope, when stated. */
  scopeQuote: string | null;
  escalateTo: string | null;
  duration: string | null;
  status: MapGuardrailStatus;
  /** Set when the expert admitted not knowing why. Never confirmed, never enforced. */
  unexplained: boolean;
  evidenceIds: string[];
}

export interface AnswerRecord {
  topic: Topic;
  entityRef: string | null;
  questionId: string | null;
  targetId: string | null;
  atMs: number;
  evidenceIds: string[];
}

/** draft: the working version; superseded: replaced by a correction before it was confirmed; confirmed: the expert confirmed it. */
export type WorkMapStatus = "draft" | "superseded" | "confirmed";

export interface WorkMapData {
  version: number;
  status: WorkMapStatus;
  confirmed: boolean;
  /** When the version was sealed; null for the working draft. */
  sealedAtMs: number | null;
  /** The expert's words that confirmed it. */
  /** The expert's words that confirmed it, and the digest of the teach-back they confirmed (see teachBackDigest). */
  confirmation: { quote: string | null; atMs: number; statedDigest: string } | null;
  steps: MapStepData[];
  guardrails: MapGuardrailData[];
  unknowns: string[];
  answered: AnswerRecord[];
}

export type MapStep = DeepReadonly<MapStepData>;
export type MapGuardrail = DeepReadonly<MapGuardrailData>;
export type WorkMap = DeepReadonly<WorkMapData>;

/** The customer rules that apply to a customer in a map. An unrecognised customer never matches. */
export function guardrailsFor(map: WorkMap, customerRef: string | null): readonly MapGuardrail[] {
  if (customerRef === null) return [];
  return map.guardrails.filter(
    (g) => g.trigger === "customer" && (g.scope.kind === "all" || g.scope.customers.includes(customerRef)),
  );
}

/** True when the map already holds the expert's answer on this topic for this entity. */
export function isAnswered(map: WorkMap, topic: Topic, entityRef: string | null): boolean {
  const recorded = map.answered.some(
    (a) => a.topic === topic && (topic === "guardrail" || entityRef === null || a.entityRef === entityRef),
  );
  if (recorded) return true;
  if (topic === "reason" && entityRef !== null) {
    return guardrailsFor(map, entityRef).some((g) => g.reason !== null && !g.unexplained);
  }
  return false;
}
