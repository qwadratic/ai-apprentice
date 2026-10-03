// Small hand-written validation helpers (no zod until stream A's skeleton lands).

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type Check = (value: unknown, path: string, errors: string[]) => void;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(value: unknown, path: string, errors: string[], opts: { allowEmpty?: boolean } = {}): void {
  if (typeof value !== "string") errors.push(`${path}: expected string`);
  else if (!opts.allowEmpty && value.length === 0) errors.push(`${path}: must not be empty`);
}

export function nullableStr(value: unknown, path: string, errors: string[]): void {
  if (value !== null) str(value, path, errors);
}

export function optionalStr(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined) str(value, path, errors);
}

export function num(
  value: unknown,
  path: string,
  errors: string[],
  opts: { min?: number; integer?: boolean } = {},
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path}: expected finite number`);
    return;
  }
  if (opts.integer && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
  if (opts.min !== undefined && value < opts.min) errors.push(`${path}: must be >= ${opts.min}`);
}

export function bool(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
}

export function oneOf(value: unknown, allowed: readonly string[], path: string, errors: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${path}: expected one of ${allowed.join("|")}`);
  }
}

export function arrayOf(value: unknown, path: string, errors: string[], item: Check): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`);
    return;
  }
  value.forEach((v, i) => item(v, `${path}[${i}]`, errors));
}

export function strArray(value: unknown, path: string, errors: string[]): void {
  arrayOf(value, path, errors, (v, p, e) => str(v, p, e));
}

/** Runs `check` on `value` as an object; reports a single error when it is not a record. */
export function object(
  value: unknown,
  path: string,
  errors: string[],
  check: (o: Record<string, unknown>) => void,
): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return;
  }
  check(value);
}

export function finish<T>(value: unknown, errors: string[]): ValidationResult<T> {
  return errors.length === 0 ? { ok: true, value: value as T } : { ok: false, errors };
}

export class ValidationError extends Error {
  readonly errors: string[];
  constructor(what: string, errors: string[]) {
    super(`${what}: ${errors.join("; ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}
