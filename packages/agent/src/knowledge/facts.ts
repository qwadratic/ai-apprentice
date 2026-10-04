// Matching order facts against free text (the message the person writes). Tolerant of case, spacing, commas and dash variants.
import type { OrderFacts } from "@apprentice/contracts";
import { FACT_KEYS } from "./types.ts";
import type { FactKey } from "./types.ts";

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/i.test(c);

/** The order's value for a fact, or null when the screen did not show it. */
export function orderFactValue(order: OrderFacts, key: FactKey): string | null {
  const v = order[key];
  return v !== null && v.trim().length > 0 ? v : null;
}

/** True when the text carries the order's value for this fact. A fact the order does not show is never present. */
export function factPresent(text: string, order: OrderFacts, key: FactKey): boolean {
  const value = orderFactValue(order, key);
  if (value === null) return false;
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(value);
  if (needle.length === 0) return false;
  if (needle.length >= 4) return haystack.includes(needle);
  // Very short values must stand alone, otherwise "5" would match inside any number.
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length])) return true;
  }
  return false;
}

/** Facts of the order that the text carries, in canonical order. */
export function factsPresentIn(text: string, order: OrderFacts): FactKey[] {
  return FACT_KEYS.filter((k) => factPresent(text, order, k));
}
