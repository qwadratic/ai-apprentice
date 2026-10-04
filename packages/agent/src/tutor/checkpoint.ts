// Tutor checkpoint: the check before Send in the demo workspace. It answers an ActionCheckpoint with a CheckpointReply
// (clear / warn / unknown) built only from the latest confirmed Work Map and the observations the checkpoint refers to.
// It quotes the expert and names the screen moments; it never guesses: an unrecognised customer, a rule whose reason the
// expert could not give, a conflicting rule, an unconfirmed map or a checkpoint that does not match the current
// observations all give "unknown", never "clear". The decision to send stays with the human.
import { ContractValidationError, SCHEMA_VERSION, assertCurrentCheckpoint } from "@apprentice/contracts";
import type { ActionCheckpoint, CheckpointReply, EmailDraftFacts, OrderFacts, ScreenObservation } from "@apprentice/contracts";
import { factPresent, orderFactValue } from "../knowledge/facts.ts";
import { latestConfirmed, validateWorkMap } from "../knowledge/map.ts";
import type { MapState } from "../knowledge/map.ts";
import { guardrailsFor, labelFacts } from "../knowledge/types.ts";
import type { FactKey, MapGuardrail, WorkMap } from "../knowledge/types.ts";

/** A CheckpointReply plus what the tutor and its tests need to explain the verdict. */
export interface TutorVerdict extends CheckpointReply {
  /** The map version the verdict rests on; null when there was no confirmed map. */
  mapVersion: number | null;
  guardrailId: string | null;
  /** Fields the rule requires in the message that are not there. */
  missingFacts: FactKey[];
  /** The expert's words quoted in the message. */
  quotes: string[];
  /** A personal rule for this customer was found and checked. */
  ruleApplied: boolean;
}

export interface CheckpointInput {
  checkpoint: ActionCheckpoint;
  /** Every observation seen so far in the session; the checkpoint names the ones it rests on. */
  observations: readonly ScreenObservation[];
  /** The latest confirmed map version, or null when there is none. */
  map: WorkMap | null;
  /** The live session, when known; a checkpoint from another session is refused. */
  sessionId?: string;
}

function moment(atMs: number | null): string {
  if (atMs === null) return "";
  const s = Math.floor(atMs / 1000);
  return ` at ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const endSentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

function quoted(g: MapGuardrail | undefined): string[] {
  return g?.quote ? [g.quote] : [];
}

interface Resolved {
  order: OrderFacts;
  email: EmailDraftFacts;
}

function resolve(input: CheckpointInput): Resolved {
  const { checkpoint: cp, observations } = input;
  assertCurrentCheckpoint(cp, input.sessionId ?? cp.sessionId, observations);
  const refs = observations.filter((o) => o.sessionId === cp.sessionId && cp.observationIds.includes(o.id));
  const order = refs.filter((o) => o.kind === "order_view").at(-1);
  const email = refs.filter((o) => o.kind === "email_draft").at(-1);
  if (order?.kind !== "order_view" || email?.kind !== "email_draft") {
    throw new ContractValidationError("checkpoint does not reference an order and a draft");
  }
  return { order: order.facts, email: email.facts };
}

/** The check before Send. Pure: the same checkpoint, observations and map always give the same answer. */
export function checkpoint(input: CheckpointInput): TutorVerdict {
  const cp = input.checkpoint;
  const map = input.map;
  const reply = (
    status: TutorVerdict["status"],
    message: string,
    evidenceIds: readonly string[],
    extra: Partial<Pick<TutorVerdict, "guardrailId" | "missingFacts" | "quotes" | "ruleApplied">> = {},
  ): TutorVerdict => ({
    schemaVersion: SCHEMA_VERSION,
    checkpointId: cp.id,
    status,
    message,
    evidenceIds: unique(evidenceIds),
    basedOn: { order: cp.revisions.order, email: cp.revisions.email },
    mapVersion: map?.version ?? null,
    guardrailId: extra.guardrailId ?? null,
    missingFacts: extra.missingFacts ?? [],
    quotes: extra.quotes ?? [],
    ruleApplied: extra.ruleApplied ?? false,
  });

  let seen: Resolved;
  try {
    seen = resolve(input);
  } catch (e) {
    if (!(e instanceof ContractValidationError)) throw e;
    return reply("unknown", `I cannot match this checkpoint to the order and the draft I am currently watching (${e.message}), so I will not judge it.`, []);
  }
  const { order, email } = seen;

  if (map === null || !map.confirmed) {
    return reply("unknown", "The rule is not confirmed by the expert yet (there is no confirmed Work Map), so I do not know what is right here. Ask the expert.", []);
  }
  const invalid = validateWorkMap(map);
  if (invalid.length > 0) {
    return reply("unknown", `The Work Map is not valid (${invalid[0]}), so I will not use it.`, []);
  }

  const customer = order.customerRef;
  if (customer === null) {
    const stop = map.guardrails.find((g) => g.trigger === "unknown_entity");
    const why = stop?.reason ? ` Their reason: ${stop.reason}.` : "";
    const tail = stop?.quote ? ` The expert said: "${endSentence(stop.quote)}"${why}` : " Ask someone who knows the customer before sending.";
    return reply("unknown", `I cannot match this order to a customer on the map, so I will not guess.${tail}`, stop?.evidenceIds ?? [], {
      guardrailId: stop?.id ?? null,
      quotes: quoted(stop),
    });
  }

  const mine = guardrailsFor(map, customer);
  if (mine.length === 0) {
    const limited = map.guardrails.find((g) => g.trigger === "customer" && !g.unexplained && g.scopeQuote !== null);
    const tail = limited?.scopeQuote
      ? ` The expert limited the rule for ${limited.scope.customers.join(", ") || "another customer"}: "${endSentence(limited.scopeQuote)}"`
      : "";
    return reply("clear", `The map has no personal rule for ${customer}, so I am not applying one.${tail}`, [], {
      quotes: limited?.scopeQuote ? [limited.scopeQuote] : [],
    });
  }

  const open = mine.find((g) => g.status !== "confirmed");
  if (open) {
    const why = open.unexplained || open.reasonUnknown
      ? "the expert said they do not know why"
      : open.status === "conflicted"
        ? "the expert gave conflicting statements about it"
        : open.reason === null
          ? "the reason was never explained"
          : "the expert has not confirmed it";
    const tail = open.quote ? ` Their words${moment(open.quoteAtMs)}: "${endSentence(open.quote)}"` : "";
    return reply("unknown", `The map holds a note for ${customer}, but ${why}, so I cannot say what is right here. Ask the expert.${tail}`, open.evidenceIds, {
      guardrailId: open.id,
      quotes: quoted(open),
    });
  }

  const required = unique(mine.flatMap((g) => g.requiredFacts));
  const first = mine[0];
  const quotes = unique(mine.flatMap((g) => quoted(g)));
  const evidenceIds = mine.flatMap((g) => g.evidenceIds);
  const ruleExtra = { guardrailId: first?.id ?? null, quotes, ruleApplied: true };
  const said =
    quotes.length > 0
      ? `the expert said${moment(first?.quoteAtMs ?? null)}: "${quotes.map(endSentence).join('" and "')}"`
      : "the expert has a rule for this customer.";

  if (required.length === 0) {
    return reply("unknown", `For ${customer} ${said} The map does not say what the message must contain, so I cannot check it. Ask the expert.`, evidenceIds, ruleExtra);
  }
  const unreadable = required.filter((f) => orderFactValue(order, f) === null);
  if (unreadable.length > 0) {
    return reply("unknown", `For ${customer} ${said} I cannot read the ${labelFacts(unreadable)} on the order, so I cannot check the message. Look at the order again.`, evidenceIds, ruleExtra);
  }
  const missing = required.filter((f) => !factPresent(email.bodyText, order, f));
  if (missing.length > 0) {
    return reply("warn", `Hold on before Send. For ${customer} ${said} Your message is still missing the ${labelFacts(missing)}.`, evidenceIds, { ...ruleExtra, missingFacts: missing });
  }

  const exception = mine.flatMap((g) => g.exceptions)[0];
  let extra = "";
  if (email.attachments.length > 0) {
    extra = exception
      ? ` The extra attachment is fine: "${endSentence(exception.quote)}"`
      : " The map does not say whether an extra attachment is fine, but what the expert asked for is in the message.";
  }
  return reply("clear", `Clear to send. For ${customer} ${said} That is in your message.${extra}`, evidenceIds, {
    ...ruleExtra,
    quotes: unique([...quotes, ...(exception && email.attachments.length > 0 ? [exception.quote] : [])]),
  });
}

/** Convenience: judge a checkpoint against the latest confirmed version in a map state. */
export function checkpointWithState(state: MapState, input: Omit<CheckpointInput, "map">): TutorVerdict {
  return checkpoint({ ...input, map: latestConfirmed(state) });
}
