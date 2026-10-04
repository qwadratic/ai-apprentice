// Heuristic answer extraction: the FAIL-SAFE fallback for when the model is not reachable (HTTP 429, timeout, error).
// The LLM route is the primary path; this module is deliberately incomplete, and its contract is one invariant:
//
//   any free-form phrase may yield "unknown" (no reason, no field, no scope change) - never a reason the expert did not
//   give, never a field they did not name, never a scope wider than they stated.
//
// So every claim is a WHITELIST: a reason needs a positive causal statement, a field must be named, a customer joins the
// scope only on an explicit inclusion ("too", "as well", "the same"). Everything else is left unknown and Review asks again.
// Its vocabulary is generic; it contains no customer rule.
import { mentionedRefs, resolveAliases } from "./entities.ts";
import type { EntityResolver } from "./entities.ts";
import type { AnswerExtraction, AnswerExtractor, ExtractionInput } from "./extractor.ts";
import { FACT_KEYS } from "./types.ts";
import type { FactKey, MapExceptionData } from "./types.ts";

// ---------------------------------------------------------------------------
// Order fields: required only when named
// ---------------------------------------------------------------------------

/**
 * A field matches only by its full name or an exact synonym, with no other qualifier word in front of it: "the address",
 * "delivery address", "delivery window", "delivery time", "time slot", "order number". "billing address", "return address",
 * a bare "time" or "date" or "window" name no field.
 */
const FIELD_NAMES: ReadonlyArray<readonly [FactKey, RegExp]> = [
  ["deliveryAddress", /(?:\b([a-z'-]+)\s+)?\b(delivery address|address)\b/gi],
  ["deliveryWindow", /(?:\b([a-z'-]+)\s+)?\b(delivery window|delivery time|time ?slot)\b/gi],
  ["orderId", /(?:\b([a-z'-]+)\s+)?\b(order (?:number|id|no\.?|ref(?:erence)?))\b/gi],
];
/** What may stand right before a field name without qualifying it: determiners, conjunctions, plain verbs. */
const FIELD_LEAD_OK = new Set([
  "the", "a", "an", "his", "her", "their", "our", "your", "my", "this", "that", "its", "delivery", "and", "or", "plus", "also", "with", "of",
  "only", "just", "both", "then", "include", "includes", "add", "put", "need", "needs", "want", "wants", "write", "type", "give", "list", "show",
]);
const ORDER_LITERAL = /\bORD-\d+|\border ?#/i;

/** The fields named in a clause. */
function namedFields(clause: string): FactKey[] {
  const found: FactKey[] = [];
  for (const [key, re] of FIELD_NAMES) {
    for (const m of clause.matchAll(re)) {
      const lead = m[1]?.toLowerCase();
      if (lead === undefined || FIELD_LEAD_OK.has(lead)) {
        found.push(key);
        break;
      }
    }
  }
  if (ORDER_LITERAL.test(clause) && !found.includes("orderId")) found.push("orderId");
  return found;
}

/** A clause that says something is NOT wanted: the fields it names are not required. "Not only X" still wants X. */
const NEGATION =
  /\b(?:not|no|never|without|except|ignore|irrelevant|skip)\b|n't\b|\bdoes ?n[o']t matter\b|\bno need\b/i;
const NOT_ONLY = /\bnot (?:only|just|merely)\b/gi;

/**
 * Words next to a field name that mean the field is NOT what the expert asks the email to carry: it is somewhere else
 * ("on the ticket", "on file"), already known ("he knows", "stays the same"), or someone else's ("of our warehouse").
 * A clause with one of these names no field.
 */
const FIELD_NEIGHBOUR_VETO =
  /\b(?:tickets?|he knows|she knows|they know|knows|stays? the same|already|on file|in the system|in our system|on the order|warehouse|(?:address|window|time|number) of|of our|of the (?:warehouse|company|office|depot|supplier))\b/i;
/** A correction adds a field to the email: "put X in it", "include X", "X goes in", "in there", "in the email". */
const ADDS_TO_EMAIL =
  /\b(?:put|puts|include|includes|including|add|adds|write|type|mention)\b|\bgoes in\b|\b(?:in|into) (?:the )?(?:email|e-mail|message|body|there|it)\b/i;

/**
 * The order fields the text asks for. A clause that says a field is not wanted ("the time doesn't matter") or that puts it
 * somewhere else does not count. With `addsOnly` (a correction) a clause counts only when it adds the field to the email.
 */
export function extractFacts(text: string, options: { addsOnly?: boolean } = {}): FactKey[] {
  const found = new Set<FactKey>();
  for (const raw of text.split(/[,;.!?]+|\s+(?:but|except|instead of|rather than)\s+/i)) {
    const clause = raw.replace(NOT_ONLY, " only ");
    if (NEGATION.test(clause) || FIELD_NEIGHBOUR_VETO.test(clause)) continue;
    if (options.addsOnly === true && !ADDS_TO_EMAIL.test(clause)) continue;
    for (const key of namedFields(clause)) found.add(key);
  }
  return FACT_KEYS.filter((k) => found.has(k));
}

// ---------------------------------------------------------------------------
// The global veto: the heuristic acts only on plain, affirmative, unhedged statements
// ---------------------------------------------------------------------------

/**
 * A question, a negation, a hedge or a contrast anywhere in the utterance. Precision over recall: such an utterance yields no
 * reason, no field, no widening of the scope, and a reply to the teach-back becomes "unclear". The model path or the buttons
 * handle it. (Restrictions and "I don't know" are kept: they can only narrow a rule or leave it unknown.)
 */
const VETO =
  /\?|n't\b|'d\b|\b(?:not|no|never|nobody|nothing|none|nor|neither|maybe|perhaps|probably|possibly|presumably|apparently|supposedly|likely|unlikely|i think|i guess|i suppose|i assume|i assumed|assumed|assume|i believe|i imagine|i reckon|i feel|i doubt|doubt|i wish|wish|might|could|would|should|if|unless|whether|eventually|used to|anymore|any more|mostly|mainly|usually|honestly|sort of|kind of|somewhat|seems?|but|although|though|actually|however|except|unsure|unclear|or so i heard|i heard|as far as i know|at least|old|older|former|formerly|previous|previously|back then|ago|last (?:year|month|week)|recently|once|now has|now have|new)\b|\bin (?:19|20)\d\d\b/i;

export function isVetoed(text: string): boolean {
  return VETO.test(text.replace(/[‘’]/g, "'"));
}

/** Every fact the answer says is wanted ("everything", "all the details"), in canonical order. */
export function extractFactsOrAll(text: string): FactKey[] {
  return /\b(?:everything|all of it|all the details)\b/i.test(text) ? [...FACT_KEYS] : extractFacts(text);
}

// ---------------------------------------------------------------------------
// Reasons: a positive causal statement, or none
// ---------------------------------------------------------------------------

/** "because X", "so that X": the reason FOLLOWS the cue. ("since" only before a subject: "since last year" is time.) */
const REASON_AFTER =
  /\b(?:because|since(?= (?:he|she|they|it|his|her|their|the|we|i|customer|there|this|that)\b)|so that|due to|owing to|on account of|in order to|to avoid|to make sure|to be sure|to ensure|otherwise|or else|thanks to|the reason(?: is| was)?)\b/i;
/** "X, that's why I ...": the reason PRECEDES the cue. */
const REASON_BEFORE =
  /\b(?:that'?s why|that is why|which is why|this is why|that'?s the reason|hence|therefore)\b|,\s*so (?=(?:i|we|he|she|they|it|the|my|our)\b)/i;

/** A third party the statement is about: the customer, their device, a system. "I can't see the point" has none. */
const THIRD_PARTY =
  /\b(?:he|she|they|it|its|his|her|their|the (?:customer|client|recipient|phone|system|mail|email|software|app|inbox|server|network|firewall|scanner)|customer_\d+|customer \w+)\b/i;
/** The customer asked, wants, needs, prefers... */
const NEED =
  /\b(?:he|she|they|customer_\d+|customer \w+|the customer|the client|the recipient|his|her|their)\b[^.!?]*?\b(?:asked|asks|asking|wants?|wanted|needs?|needed|prefers?|preferred|requested|requests?|requires?|required|insists?|insisted|demands?|demanded|likes?|expects?)\b|\b(?:i|we)(?: was| were|'m| am| are)? (?:asked|instructed|required|obliged)\b|\bmy (?:manager|boss|lead|supervisor)\b[^.!?]*\b(?:wants|asked|requires)\b/i;
/** A stated constraint: can't open/see/read, blocks, filters. */
const CONSTRAINT =
  /\b(?:can'?t|cannot|can not|couldn'?t|doesn'?t|does not|don'?t|do not|won'?t|unable to|not able to|isn'?t able to|aren'?t able to)\s+(?:\w+\s+){0,2}?(?:open|see|read|view|show|display|receive|get|handle|process|use|download|load|accept|render|print)\b|\b(?:blocks?|blocked|blocking|filters?|filtered|strips?|stripped|rejects?|rejected|bounces?|bounced|garbles?|corrupts?|breaks?|truncates?|hides?|hidden)\b/i;
/** A rule, a contract, a regulation as the source. */
const AUTHORITY =
  /\b(?:company|our|the|his|their) (?:policy|policies|rules?|contract|agreement|regulations?|compliance)\b|\b(?:policy|rule|law|contract|agreement|regulation)s? (?:says?|states?|requires?|demands?|prohibits?|forbids?)\b|\brequired by\b|\bby law\b|\blegal(?:ly)? (?:requirement|obligation)\b|\bgdpr\b/i;

/**
 * A non-answer to "why": not sure, don't know, don't remember, beats me, can't say, good question... A thought that contains
 * one never yields a reason, even if it also contains "because" ("I don't know, because nobody told me").
 */
const NON_ANSWER =
  /\b(?:i'?m |i am )?not (?:really |entirely |completely |quite |exactly )?(?:sure|certain)\b|\bnot (?:a )?(?:hundred|100)(?: ?(?:percent|%))?(?: sure| certain)?|\b(?:don'?t|do not|doesn'?t|does not|didn'?t|did not|can'?t|cannot|can not|couldn'?t|could not|won'?t|wouldn'?t|never|hardly) (?:really |quite |exactly |even )?(?:know|knew|remember|recall|say|tell|see why|see the (?:point|reason)|think)\b|\b(?:nobody|no one|no-one) (?:knows|remembers|told|tells|said)\b|\bunaware\b|\b(?:i )?(?:forgot|forget|have forgotten)\b|\bno (?:real |particular )?(?:idea|clue)\b|\bwho knows\b|\bbeats me\b|\bnot something i (?:know|remember)\b|\bgood question\b|\bhave to (?:think|check|ask|look)\b|\b(?:dunno|idk)\b/i;
/** The expert says outright that there is no reason or that they never found it out. Applies to every topic. */
const UNKNOWN_REASON_CUE =
  /\b(?:never (?:found out|asked|learned|knew)|no idea|don'?t know why|do not know why|not sure why|can'?t say why|dunno|idk|no clue|just because|no (?:particular |real )?reason)\b/i;

const LEADING_HEDGE = /^(?:(?:well|so|um|uh|er|hmm|yeah|yes|yep|okay|ok|right|sure|honestly|basically|actually|look|i think|i guess|i believe|maybe|probably|perhaps)\b[\s,.-]*)+/i;

const stripEnd = (s: string): string => s.replace(/[\s.!?,;:-]+$/, "").trim();
const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Separate thoughts of one sentence: "I'm not sure, but I think it's because ..." is two. */
function thoughtsOf(sentence: string): string[] {
  return sentence
    .split(/\s*;\s*|\s+(?:but|however|though|although|yet)\s+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Who the expert asks or defers to in a sentence ("ask the finance lead first"), or null. */
export function findEscalateTo(text: string): string | null {
  return WHO_CUE.exec(text)?.[1]?.trim() ?? null;
}

function clauseAfter(sentence: string, cue: RegExp): string | null {
  const m = cue.exec(sentence);
  if (!m) return null;
  const rest = sentence.slice(m.index + m[0].length).replace(/^[\s,:-]+/, "");
  const clause = rest
    .split(/(?<=[.!?])\s|,\s*so\b/i)[0]
    ?.replace(/[.!?]+$/, "")
    .trim();
  return clause && wordCount(clause) >= 2 ? clause : null;
}

function clauseBefore(sentence: string, cue: RegExp): string | null {
  const m = cue.exec(sentence);
  if (!m) return null;
  const clause = stripEnd(sentence.slice(0, m.index));
  return clause && wordCount(clause) >= 2 ? clause : null;
}

interface FoundReason {
  rationale: string;
  /** The expert's own words that carry it: a verbatim span of the answer. */
  quote: string;
}

/**
 * The reason in a sentence, or null. Only a positive causal statement counts: a connective (because, so that, due to,
 * that's why...), or, when a reason was asked for, the customer asking/wanting/needing something, a stated constraint
 * (can't open, blocks, filters) or a rule as the source. A thought containing a non-answer never yields one.
 */
function reasonIn(sentence: string, index: number, sentences: readonly string[], statements: boolean): FoundReason | null {
  for (const thought of thoughtsOf(sentence)) {
    if (NON_ANSWER.test(thought)) continue;
    const after = REASON_AFTER.test(thought) ? clauseAfter(thought, REASON_AFTER) : null;
    if (after) return { rationale: after, quote: sentence };
    if (REASON_BEFORE.test(thought)) {
      const before = clauseBefore(thought, REASON_BEFORE);
      if (before) return { rationale: before, quote: sentence };
      const previous = sentences[index - 1];
      if (previous !== undefined && wordCount(previous) >= 3 && !NON_ANSWER.test(previous)) {
        return { rationale: stripEnd(previous), quote: previous };
      }
    }
    if (!statements) continue;
    const stated = NEED.test(thought) || AUTHORITY.test(thought) || (CONSTRAINT.test(thought) && THIRD_PARTY.test(thought));
    if (!stated) continue;
    const body = stripEnd(thought.replace(LEADING_HEDGE, ""));
    if (wordCount(body) < 3) continue;
    // "It is his device. It filters attachments.": a pronoun refers back to the short sentence before it.
    const previous = sentences[index - 1];
    if (/^(?:it|that|this|they|he|she)\b/i.test(thought) && previous !== undefined && wordCount(previous) <= 8 && !NON_ANSWER.test(previous)) {
      return { rationale: `${stripEnd(previous)}. ${body}`, quote: `${previous} ${sentence}` };
    }
    return { rationale: body, quote: sentence };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scope: widened only on an explicit inclusion
// ---------------------------------------------------------------------------

/** Restricts or contrasts. A sentence with one of these never widens anything ("only him, everyone else gets the template"). */
const EXCLUSION =
  /\b(?:only|just|else|rest|except|besides|apart from|nobody|no one|none|fine|still|already|usual(?:ly)?|normal(?:ly)?|standard|default|ordinary|typical|different|differs?|unlike|exceptions?|instead|rather|always|as before|as usual)\b/i;
const NEGATED = /\b(?:not|never|nor|neither)\b|n't\b/i;
/** An explicit inclusion of the customers a sentence names: X too, also X, X as well, same for X, X is the same, X and Y. */
const INCLUSION =
  /\b(?:too|also|as well|likewise|both|plus)\b|\bsame (?:for|goes for|applies to|here|thing)\b|\bsame as (?:him|her|them|customer\b|that one|this one|the first)|\b(?:is|are) the same(?! as\b)|\bsame\b[\s.!]*$/i;
/** An explicit inclusion of everyone: "for every customer", "every customer gets it", "everyone needs it". */
const ALL_INCLUSION =
  /\b(?:it|this|that)(?: is|'s) for (?:all|every customer|everyone|everybody)\b(?! (?:the|these|those|my|our|your|his|her|their))|\bfor (?:all|every) customers?\b|\bfor (?:everyone|everybody)\b|\bapplies to (?:all|every|everyone)\b/i;
/** A customer named together with a condition or a time: "when", "for", "on", "last year", "once", "back when", "I heard". */
const JOIN_QUALIFIER = /\b(?:when|for|on|during|after|before|until|while|whenever|last (?:year|month|week)|once|back when|i heard|ago)\b/i;
/**
 * A qualifier next to a scope statement: a place, a group, a time or a relation. "For every customer in Austria" is not "every
 * customer", "starting Monday" is not "from now on" and "customer twelve's sister company" is not customer twelve. A sentence
 * with one widens nothing and adds no customer; it is left to the model or the expert's own words.
 */
const SCOPE_QUALIFIER = new RegExp(
  [
    // "in Austria", "at their warehouse", "from Monday", "starting Monday", "until May" (but "put it in the email" is not one)
    String.raw`\bin\b(?! (?:the |this |that |an? )?(?:e-?mail|message|body|subject|mail|writing|text|it|there|full)\b)`,
    String.raw`\b(?:at|from|starting|starts?|begins?|beginning|since|until|till|within|inside|outside|near)\b`,
    // a group or a relation: "his group", "sister company", "the parent", "the branch"
    String.raw`\b(?:groups?|region|country|branch(?:es)?|subsidiar(?:y|ies)|parent|sister|affiliates?|offices?|warehouses?|depots?|sites?|locations?|divisions?|departments?|teams?|franchises?|chains?)\b`,
    // a possessive ("customer twelve's"), not a contraction ("that's", "it's")
    String.raw`(?<!\b(?:it|that|he|she|there|what|who|here|let|how|where|when))['\u2019]s\b`,
  ].join("|"),
  "i",
);
const ONLY = /\b(?:only|just)\b/i;
/** What opens a reply to the teach-back and says nothing about scope: "No,", "Not quite,", "Yes.", "Almost,". */
const LEAD_TOKENS = /^(?:(?:no|nope|nah|not quite|not exactly|not really|almost|yes|yeah|yep|okay|ok|right|actually|well|um|uh|hmm)\b[\s,.!-]*)+/i;

/** The thoughts of a sentence as far as scope goes: opening denials are dropped, "but ..." starts a new thought. */
function scopeThoughts(sentence: string): string[] {
  return thoughtsOf(sentence.replace(LEAD_TOKENS, "")).filter((t) => t.length > 0);
}

/** The customers named in one thought that join the rule: an explicit inclusion, and no exclusion or negation in that thought. */
function joinedByThought(thought: string, refs: readonly string[]): string[] {
  if (refs.length === 0 || EXCLUSION.test(thought) || NEGATED.test(thought)) return [];
  // A customer with a condition or a time qualifier is not an inclusion ("same for X" is: its "for" is part of the phrase).
  if (JOIN_QUALIFIER.test(thought.replace(/\bsame for\b/gi, "same"))) return [];
  return INCLUSION.test(thought) || (refs.length >= 2 && /\band\b/i.test(thought)) ? [...refs] : [];
}

/** The customers of a sentence that join the rule. Each thought stands alone: "customer nine as well, but customer three not" adds only nine. */
export function joinedCustomers(sentence: string, mentions: (text: string) => string[]): string[] {
  if (SCOPE_QUALIFIER.test(sentence)) return [];
  return [...new Set(scopeThoughts(sentence).flatMap((t) => joinedByThought(t, mentions(t))))];
}

/**
 * May this customer join the scope of the rule because of this answer? Only when a thought that names them includes them
 * explicitly and does not exclude. The customer the question was about is the rule's own customer and needs no such sentence.
 */
export function mayJoinScope(input: ExtractionInput, ref: string): boolean {
  if (ref === input.entityRef) return true;
  if (input.topic !== "scope" && input.topic !== "correction") return false;
  const mentions = (t: string): string[] => mentionedRefs(t, { knownRefs: input.knownRefs, aliases: input.aliases });
  return splitSentences(input.text).some((s) => joinedCustomers(s, mentions).includes(ref));
}

// ---------------------------------------------------------------------------
// Other cues
// ---------------------------------------------------------------------------

const EXCEPTION_CUE = /\b(?:fine|ok|okay|allowed|acceptable|no problem|doesn't matter|does not matter|on top)\b/i;
const RETRACT_CUE = /\b(?:actually,? (?:no|not)|not needed any more|no longer|ignore that|scratch that|never mind)\b/i;
const CONFIRM_CUE = /^\s*(?:yes|yep|yeah|correct|right|exactly|that's (?:right|correct)|confirmed)\b/i;
const STOP_CUE = /\bif (.+?),? I (?:stop|hold|ask|check|escalate)\b/i;
const WHO_CUE =
  /\b(?:ask|check with|call|escalate to|tell|ping)\s+((?:the|my)\s+[a-z]+(?:\s+[a-z]+)?)(?=\s+(?:first|before|about)|[.,;!?]|$)/i;

export function heuristicExtract(input: ExtractionInput): AnswerExtraction {
  const text = input.text.trim();
  const sentences = splitSentences(text);
  const mentions = (s: string): string[] => mentionedRefs(s, { knownRefs: input.knownRefs, aliases: input.aliases });
  const asksWhy = input.topic === "reason" || input.topic === "why_stop";
  // A reason may also be corrected in the teach-back; statements ("the device filters attachments") count there too.
  const statements = asksWhy || input.topic === "correction";

  let rationale: string | null = null;
  let reasonQuote: string | null = null;
  let strictUnknown = false;
  let anyNonAnswer = false;
  let scopeAll = false;
  let scopeQuote: string | null = null;
  let restricted = false;
  let restrictionQuote: string | null = null;
  let allQuote: string | null = null;
  let stopCondition: string | null = null;
  let stopQuote: string | null = null;
  let escalateTo: string | null = null;
  const exceptions: MapExceptionData[] = [];
  const unexplainedCustomers: Array<{ customerRef: string; quote: string }> = [];
  const scopeCustomers = new Set<string>();
  let joinQuote: string | null = null;
  const unknowns: string[] = [];

  sentences.forEach((s, i) => {
    const unknownWhy = UNKNOWN_REASON_CUE.test(s);
    if (asksWhy && !unknownWhy && NON_ANSWER.test(s)) anyNonAnswer = true;
    const refs = mentions(s);
    if (unknownWhy) {
      strictUnknown = true;
      for (const ref of refs) {
        unexplainedCustomers.push({ customerRef: ref, quote: s });
        unknowns.push(`The expert does not know why ${ref} is treated this way.`);
      }
      if (refs.length === 0) unknowns.push("The expert does not know why.");
    } else {
      if (rationale === null) {
        const found = reasonIn(s, i, sentences, statements);
        if (found) {
          rationale = found.rationale;
          reasonQuote = found.quote;
        }
      }
      if (input.topic === "scope" || input.topic === "correction") {
        const excludes = EXCLUSION.test(s);
        if (ONLY.test(s) && input.topic === "scope") {
          restricted = true;
          restrictionQuote ??= s;
          // "Only customer seven": the rule's own customer, already in the scope; any other customer named here is not added.
          for (const ref of refs) if (ref === input.entityRef) scopeCustomers.add(ref);
        } else if (excludes) {
          restricted = true;
        }
        const joined = joinedCustomers(s, mentions);
        if (joined.length > 0) {
          for (const ref of joined) scopeCustomers.add(ref);
          joinQuote ??= s;
        }
        // Everyone is never read from an answer to the scope question: "Every customer gets the picture." is the default, not
        // the rule, and the heuristic cannot tell the two apart. Only an explicit amendment of the teach-back widens, and the
        // next teach-back states "for every customer" for the expert to confirm.
        if (input.topic === "correction" && !SCOPE_QUALIFIER.test(s) && scopeThoughts(s).some((t) => ALL_INCLUSION.test(t) && !EXCLUSION.test(t) && !NEGATED.test(t))) {
          scopeAll = true;
          allQuote ??= s;
        }
      }
    }
    if (input.topic === "exception" && !unknownWhy && EXCEPTION_CUE.test(s)) exceptions.push({ text: s, quote: s });
    const cond = STOP_CUE.exec(s);
    if (cond && stopCondition === null) {
      stopCondition = cond[1]?.trim() ?? null;
      stopQuote = s;
    }
    const who = WHO_CUE.exec(s);
    if (who && escalateTo === null) escalateTo = who[1]?.trim() ?? null;
  });

  const retracts = RETRACT_CUE.test(text);
  const veto = isVetoed(text);
  if (retracts || veto) {
    rationale = null;
    reasonQuote = null;
  }
  if (veto) {
    // Nothing that could be wrong in the unsafe direction: no widening, no exception, no field.
    scopeAll = false;
    scopeCustomers.clear();
    joinQuote = null;
    exceptions.length = 0;
    if (input.topic === "scope") for (const ref of mentions(restrictionQuote ?? "")) if (ref === input.entityRef) scopeCustomers.add(ref);
  }
  // Never wider than stated: an answer that restricts or contrasts anywhere does not widen the rule to everyone.
  if (restricted) scopeAll = false;
  scopeQuote = scopeAll ? allQuote : (joinQuote ?? restrictionQuote);
  const scopeExplicit = scopeAll || scopeCustomers.size > 0 || (input.topic === "scope" && restricted && restrictionQuote !== null);

  let reasonUnknown = strictUnknown;
  if (asksWhy && rationale === null && anyNonAnswer) {
    reasonUnknown = true;
    unknowns.push("The expert does not know why.");
  }

  // A field is required only from an answer to the essentials question, or from a correction that adds it to the email.
  const factsOf = (t: string): FactKey[] =>
    veto ? [] : input.topic === "essentials" ? extractFacts(t) : input.topic === "correction" ? extractFacts(t, { addsOnly: true }) : [];
  const requiredFacts = factsOf(text);
  const factSentence = sentences.find((s) => factsOf(s).length > 0) ?? null;

  let quote: string;
  let evidenceOfClaim: boolean;
  switch (input.topic) {
    case "reason":
    case "why_stop":
      quote = reasonQuote ?? text;
      evidenceOfClaim = rationale !== null;
      break;
    case "essentials":
      quote = factSentence ?? text;
      evidenceOfClaim = requiredFacts.length > 0;
      break;
    case "guardrail":
      quote = stopQuote ?? text;
      evidenceOfClaim = stopCondition !== null;
      break;
    case "scope":
      quote = scopeQuote ?? text;
      evidenceOfClaim = scopeExplicit;
      break;
    case "exception":
      quote = exceptions[0]?.quote ?? text;
      evidenceOfClaim = exceptions.length > 0;
      break;
    default:
      quote = text;
      evidenceOfClaim = false;
  }

  return {
    schemaVersion: 1,
    topic: input.topic,
    questionId: input.questionId,
    atMs: input.atMs,
    evidenceIds: [...input.evidenceIds],
    targetId: input.targetId,
    entityRef: input.entityRef,
    text,
    quote,
    rationale,
    reasonQuote,
    reasonUnknown,
    scope: { explicit: scopeExplicit, all: scopeAll, customers: [...scopeCustomers] },
    scopeQuote,
    requiredFacts,
    exceptions,
    unknowns,
    stopCondition,
    escalateTo,
    unexplainedCustomers,
    retracts,
    confirms: CONFIRM_CUE.test(text),
    confidence: evidenceOfClaim ? 0.7 : 0.4,
  };
}

export class HeuristicAnswerExtractor implements AnswerExtractor {
  readonly name = "heuristic";
  private readonly resolver: EntityResolver | undefined;
  /** An optional EntityResolver resolves spoken customer phrases the numeric scheme cannot ("customer Kowalski"). */
  constructor(resolver?: EntityResolver) {
    this.resolver = resolver;
  }
  async extract(input: ExtractionInput): Promise<AnswerExtraction> {
    const aliases = { ...(await resolveAliases(input.text, input.knownRefs, this.resolver)), ...input.aliases };
    return heuristicExtract({ ...input, aliases });
  }
}
