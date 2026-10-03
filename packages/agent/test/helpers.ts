// Test helpers. Tests assert that a value exists with must(), which throws a readable error,
// instead of using the non-null assertion operator.

export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

/** The last element; the array must not be empty. */
export function lastOf<T>(items: readonly T[]): T {
  return must(items.at(-1), "last element");
}
