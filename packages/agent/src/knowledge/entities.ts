// Customers named in speech. The screen gives stable refs ("customer_07"); a person says "customer seven", "customer 07" or
// "customer zero seven". Spoken mentions are mapped onto the refs seen on screen (knownRefs); a mention that matches no known
// ref is never invented. An EntityResolver (heuristic here, LLM-backed in llm/) can resolve phrases this module cannot.

export interface EntityResolver {
  readonly name: string;
  /** The known ref the spoken phrase means, or null when it cannot be told. The result must be one of knownRefs. */
  resolve(spoken: string, knownRefs: readonly string[]): Promise<string | null>;
}

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** The number a leading run of digits or number words stands for ("07", "seven", "zero seven", "twenty one"), or null. */
export function spokenNumber(words: readonly string[]): number | null {
  const lead: string[] = [];
  for (const w of words) {
    const t = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t.length === 0) break;
    if (/^\d+$/.test(t) || t in UNITS || t in TENS) lead.push(t);
    else break;
  }
  const first = lead[0];
  if (first === undefined) return null;
  if (/^\d+$/.test(first)) return Number.parseInt(first, 10);
  const single = (t: string | undefined): boolean => t !== undefined && t in UNITS && (UNITS[t] ?? 99) <= 9;
  // "zero seven", "oh seven", "one two": digits read one by one.
  if (lead.length > 1 && lead.every(single)) return Number.parseInt(lead.map((t) => String(UNITS[t])).join(""), 10);
  const a = TENS[first];
  if (a !== undefined) {
    const b = lead[1];
    return a + (single(b) && b !== undefined ? (UNITS[b] ?? 0) : 0);
  }
  return UNITS[first] ?? null;
}

/** The number in a ref such as "customer_07" (7), or null. */
export function refNumber(ref: string): number | null {
  const m = /(\d+)\s*$/.exec(ref);
  return m?.[1] === undefined ? null : Number.parseInt(m[1], 10);
}

const SCHEME = /^customer_(\d+)$/;

/**
 * The known ref with this number. A customer the screen has not shown yet gets a ref in the scheme the known refs use
 * ("customer_09" next to "customer_07"), so a mention of them can be matched later; with refs of another scheme, none.
 */
export function refForNumber(n: number, knownRefs: readonly string[] | undefined): string | null {
  const known = knownRefs?.find((r) => refNumber(r) === n);
  if (known !== undefined) return known;
  if (knownRefs !== undefined && knownRefs.length > 0 && !knownRefs.every((r) => SCHEME.test(r))) return null;
  const width = SCHEME.exec(knownRefs?.[0] ?? "")?.[1]?.length ?? 2;
  return `customer_${String(n).padStart(width, "0")}`;
}

export interface MentionContext {
  knownRefs?: readonly string[] | undefined;
  /** Phrases (lower case) already resolved by an EntityResolver, to their refs. */
  aliases?: Readonly<Record<string, string>> | undefined;
}

const CANONICAL = /\bcustomer_\d+\b/gi;
const SPOKEN = /\bcustomers?[\s_-]*(?:number\s+|no\.?\s*|#\s*)?([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})/gi;

/** Customers named in a piece of text, in the order they are named, once each. */
export function mentionedRefs(text: string, ctx: MentionContext = {}): string[] {
  const found: Array<{ at: number; ref: string }> = [];
  const lower = text.toLowerCase();
  for (const [phrase, ref] of Object.entries(ctx.aliases ?? {})) {
    const at = lower.indexOf(phrase.toLowerCase());
    if (at !== -1) found.push({ at, ref });
  }
  for (const m of text.matchAll(CANONICAL)) {
    const token = m[0].toLowerCase();
    const known = ctx.knownRefs?.find((r) => r.toLowerCase() === token);
    const n = refNumber(token);
    found.push({ at: m.index, ref: known ?? (n !== null ? (refForNumber(n, ctx.knownRefs) ?? token) : token) });
  }
  for (const m of text.matchAll(SPOKEN)) {
    if (/^customer_/i.test(m[0])) continue; // handled above
    const n = spokenNumber((m[1] ?? "").split(/\s+/));
    const ref = n === null ? null : refForNumber(n, ctx.knownRefs);
    if (ref !== null) found.push({ at: m.index, ref });
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.ref))];
}

const STOP_WORDS = new Set([
  "asks", "asked", "wants", "wanted", "needs", "needed", "is", "was", "has", "gets", "got", "and", "or", "but", "because", "only", "always",
  "never", "cannot", "can't", "doesn't", "does", "did", "will", "would", "to", "for", "with", "so", "if", "when", "who", "that", "which",
  "these", "it", "they", "he", "she", "still", "also", "just", "even", "gets", "likes", "prefers", "told", "says", "said",
]);

/** Phrases that name a customer in a way the numeric scheme cannot resolve ("customer Kowalski"): candidates for an EntityResolver. */
export function unresolvedCustomerPhrases(text: string, knownRefs: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPOKEN)) {
    if (/^customer_/i.test(m[0])) continue;
    const words = (m[1] ?? "").split(/\s+/);
    if (spokenNumber(words) !== null && refForNumber(spokenNumber(words) ?? 0, knownRefs) !== null) continue;
    const kept: string[] = [];
    for (const w of words) {
      if (STOP_WORDS.has(w.toLowerCase())) break;
      kept.push(w);
    }
    if (kept.length > 0) out.push(`customer ${kept.join(" ")}`);
  }
  return [...new Set(out)];
}

/** Maps spoken phrases that the numeric scheme cannot resolve to refs with an EntityResolver; the result feeds MentionContext.aliases. */
export async function resolveAliases(
  text: string,
  knownRefs: readonly string[] | undefined,
  resolver: EntityResolver | undefined,
): Promise<Record<string, string>> {
  const aliases: Record<string, string> = {};
  if (resolver === undefined || knownRefs === undefined || knownRefs.length === 0) return aliases;
  for (const phrase of unresolvedCustomerPhrases(text, knownRefs)) {
    const ref = await resolver.resolve(phrase, knownRefs);
    if (ref !== null && knownRefs.includes(ref)) aliases[phrase.toLowerCase()] = ref;
  }
  return aliases;
}

/** Numeric resolution only: "customer seven", "customer 07", "customer_7" onto the known refs. */
export class HeuristicEntityResolver implements EntityResolver {
  readonly name = "heuristic";
  resolve(spoken: string, knownRefs: readonly string[]): Promise<string | null> {
    const ref = mentionedRefs(spoken, { knownRefs })[0];
    return Promise.resolve(ref !== undefined && knownRefs.includes(ref) ? ref : null);
  }
}
