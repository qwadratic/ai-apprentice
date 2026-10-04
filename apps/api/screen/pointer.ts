// The mouse pointer as an optional hint on a frame upload (the macOS app sends it; the web does not). Positions are
// normalised 0..1 to the processed frame, origin top left, like the vision boxes. The hint is never stored: it only
// adds one line to the vision request of the frame it came with.

/** `[x, y, msAgo]`: where the pointer was this many milliseconds before the frame. */
export type PointerTrailPoint = readonly [number, number, number];
export interface PointerHint {
  readonly x: number; readonly y: number;
  /** How long the pointer has rested near (x, y), in ms; 0 while it moves. */
  readonly dwellMs: number;
  /** At most MAX_POINTER_TRAIL earlier positions, any order. */
  readonly trail: readonly PointerTrailPoint[];
}
export const MAX_POINTER_TRAIL = 8;
/** Below this the pointer counts as moving. */
export const POINTER_RESTING_MS = 600;

const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The upload's `pointer` field, or null when it is absent or malformed. A hint never fails a frame: a bad one is
 * dropped and the frame goes on without it. Extra trail points past MAX_POINTER_TRAIL are left out.
 */
export function parsePointerHint(value: unknown): PointerHint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (!unit(source.x) || !unit(source.y)) return null;
  const dwellMs = source.dwellMs === undefined ? 0 : source.dwellMs;
  if (!nonNegative(dwellMs)) return null;
  const rawTrail = source.trail === undefined ? [] : source.trail;
  if (!Array.isArray(rawTrail)) return null;
  const trail: PointerTrailPoint[] = [];
  for (const point of rawTrail.slice(0, MAX_POINTER_TRAIL)) {
    if (!Array.isArray(point) || point.length !== 3 || !unit(point[0]) || !unit(point[1]) || !nonNegative(point[2])) return null;
    trail.push([point[0], point[1], Math.min(Math.round(point[2]), 60_000)]);
  }
  return Object.freeze({x: source.x, y: source.y, dwellMs: Math.min(Math.round(dwellMs), 600_000), trail: Object.freeze(trail)});
}

const at = (x: number, y: number): string => `(${x.toFixed(2)}, ${y.toFixed(2)})`;

/** One short line for the vision request, e.g. "Pointer: resting 1.4 s at (0.62, 0.81)." */
export function pointerLine(hint: PointerHint): string {
  if (hint.dwellMs >= POINTER_RESTING_MS) return `Pointer: resting ${(hint.dwellMs / 1000).toFixed(1)} s at ${at(hint.x, hint.y)}.`;
  const oldest = hint.trail.reduce<PointerTrailPoint | null>((found, point) => !found || point[2] > found[2] ? point : found, null);
  if (oldest && Math.hypot(oldest[0] - hint.x, oldest[1] - hint.y) >= 0.01) {
    return `Pointer: moving from ${at(oldest[0], oldest[1])} to ${at(hint.x, hint.y)}.`;
  }
  return `Pointer: at ${at(hint.x, hint.y)}.`;
}
