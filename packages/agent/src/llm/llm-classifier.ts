// LLM-backed reading of the expert's reply to the teach-back (route task "reply_classification") and of spoken customer
// phrases (task "entity_resolution"), behind the ReplyClassifier and EntityResolver interfaces. Output is parsed and
// validated at runtime; on an error, a timeout or an unusable output the heuristic answers and the fallback is logged.
import { HeuristicEntityResolver } from "../knowledge/entities.ts";
import type { EntityResolver } from "../knowledge/entities.ts";
import { HeuristicReplyClassifier } from "../knowledge/review.ts";
import type { ReplyClassifier, ReplyVerdict } from "../knowledge/review.ts";
import { isJsonObject } from "./client.ts";
import type { LlmClient } from "./client.ts";

/** The route's limits: a teach-back of up to 4000 characters (longer is cut, it is only context), a reply of up to 2000. */
const MAX_TEACH_BACK = 4000;
const MAX_REPLY = 2000;

/** Task reply_classification: what the route is sent, and what it answers. */
export interface ReplyClassificationRequest {
  teachBack: string;
  reply: string;
}
export interface ReplyClassificationOutput {
  verdict: "confirm" | "correct" | "unclear";
  correction: string | null;
}

export function parseReplyClassificationOutput(raw: unknown): ReplyClassificationOutput | null {
  if (!isJsonObject(raw)) return null;
  const { verdict, correction } = raw;
  if (verdict !== "confirm" && verdict !== "correct" && verdict !== "unclear") return null;
  if (correction !== null && typeof correction !== "string") return null;
  return { verdict, correction: correction === null ? null : correction.trim() || null };
}

export interface LlmReplyClassifierOptions {
  client: LlmClient;
  /** Used when the model fails. Default: the heuristic classifier. */
  fallback?: ReplyClassifier;
}

export class LlmReplyClassifier implements ReplyClassifier {
  readonly name = "llm";
  private readonly client: LlmClient;
  private readonly fallback: ReplyClassifier;

  constructor(options: LlmReplyClassifierOptions) {
    this.client = options.client;
    this.fallback = options.fallback ?? new HeuristicReplyClassifier();
  }

  async classify(teachBack: string, reply: string): Promise<ReplyVerdict> {
    if (reply.trim().length === 0 || reply.length > MAX_REPLY) {
      this.client.skip("reply_classification");
      return this.fallback.classify(teachBack, reply);
    }
    const request: ReplyClassificationRequest = { teachBack: teachBack.slice(0, MAX_TEACH_BACK), reply };
    const { result, startedAt } = await this.client.call("reply_classification", request);
    if (!result.ok) {
      this.client.record("reply_classification", startedAt, "fallback", result.reason, result.status);
      return this.fallback.classify(teachBack, reply);
    }
    const out = parseReplyClassificationOutput(result.output);
    if (out === null) {
      this.client.record("reply_classification", startedAt, "fallback", "invalid_output");
      return this.fallback.classify(teachBack, reply);
    }
    this.client.record("reply_classification", startedAt, "llm");
    return { verdict: out.verdict, correction: out.verdict === "correct" ? out.correction : null };
  }
}

/** Task entity_resolution: what the route is sent, and what it answers. */
export interface EntityResolutionRequest {
  spoken: string;
  knownRefs: string[];
}
export interface EntityResolutionOutput {
  ref: string | null;
}

/** A ref that is not one of the known refs is a hallucination and makes the output unusable. */
export function parseEntityResolutionOutput(raw: unknown, knownRefs: readonly string[]): EntityResolutionOutput | null {
  if (!isJsonObject(raw)) return null;
  const { ref } = raw;
  if (ref === null) return { ref: null };
  if (typeof ref !== "string" || !knownRefs.includes(ref)) return null;
  return { ref };
}

export interface LlmEntityResolverOptions {
  client: LlmClient;
  /** Used when the model fails. Default: the numeric heuristic. */
  fallback?: EntityResolver;
}

export class LlmEntityResolver implements EntityResolver {
  readonly name = "llm";
  private readonly client: LlmClient;
  private readonly fallback: EntityResolver;

  constructor(options: LlmEntityResolverOptions) {
    this.client = options.client;
    this.fallback = options.fallback ?? new HeuristicEntityResolver();
  }

  async resolve(spoken: string, knownRefs: readonly string[]): Promise<string | null> {
    // The numeric scheme is exact and free: only phrases it cannot resolve go to the model.
    const local = await new HeuristicEntityResolver().resolve(spoken, knownRefs);
    if (local !== null) return local;
    // The route needs a phrase of up to 200 characters and 1 to 100 known refs of up to 64 characters.
    const refs = knownRefs.filter((r) => r.length > 0 && r.length <= 64).slice(0, 100);
    if (spoken.trim().length === 0 || spoken.length > 200 || refs.length === 0) {
      this.client.skip("entity_resolution");
      return this.fallback.resolve(spoken, knownRefs);
    }
    const request: EntityResolutionRequest = { spoken, knownRefs: refs };
    const { result, startedAt } = await this.client.call("entity_resolution", request);
    if (!result.ok) {
      this.client.record("entity_resolution", startedAt, "fallback", result.reason, result.status);
      return this.fallback.resolve(spoken, knownRefs);
    }
    const out = parseEntityResolutionOutput(result.output, knownRefs);
    if (out === null) {
      this.client.record("entity_resolution", startedAt, "fallback", "invalid_output");
      return this.fallback.resolve(spoken, knownRefs);
    }
    this.client.record("entity_resolution", startedAt, "llm");
    return out.ref;
  }
}
