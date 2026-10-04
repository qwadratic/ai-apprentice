/*
 * Placement and flight geometry. Pure: plain numbers and boxes, no DOM, so it is unit-tested in node.
 *
 * Coordinates are viewport pixels (the same space as getBoundingClientRect), y grows downwards.
 *   - placeBeside: where Clipa lands next to a target rect (right, then left, above, below), inside the
 *     viewport, never overlapping the rect.
 *   - placeBubble: where the speech bubble goes, on the side of Clipa that faces away from the target.
 *   - planFlightPath: a cubic bezier arc from A to B that does not cross the target and stays inside.
 *   - flightDuration, easing and the small direction helpers for the eyes and the pointing arm.
 */
import type { ClipaDock, RectLike } from './types.ts';

export interface Pt {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Side = 'right' | 'left' | 'top' | 'bottom';

/** Timings from the spec. Approach is 600-900 ms by distance; retreat is 500 ms; notice 0.3 s. */
export const NOTICE_MS = 300;
export const RETREAT_MS = 500;
export const FLIGHT_MIN_MS = 600;
export const FLIGHT_MAX_MS = 900;

export const DEFAULT_SIDE_ORDER: readonly Side[] = ['right', 'left', 'top', 'bottom'];

export function boxFromRect(r: RectLike): Box {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
export function center(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
export function boxAt(c: Pt, size: Size): Box {
  return { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h };
}
export function inflate(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by };
}
export function intersection(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : null;
}
/** Area of the common part; boxes that only touch have none. */
export function overlapArea(a: Box, b: Box): number {
  const i = intersection(a, b);
  return i ? i.w * i.h : 0;
}
export function overlaps(a: Box, b: Box): boolean {
  return overlapArea(a, b) > 0;
}
export function insideViewport(b: Box, vp: Size, margin = 0): boolean {
  return b.x >= margin && b.y >= margin && b.x + b.w <= vp.w - margin && b.y + b.h <= vp.h - margin;
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** The centre of Clipa's box when docked (`scale` below 1) or when standing in the dock corner at full size. */
export function dockCenter(corner: ClipaDock, vp: Size, size: Size, scale: number, margin: number): Pt {
  const hw = (size.w * scale) / 2;
  const hh = (size.h * scale) / 2;
  const right = corner === 'bottom-right' || corner === 'top-right';
  const bottom = corner === 'bottom-right' || corner === 'bottom-left';
  return { x: right ? vp.w - margin - hw : margin + hw, y: bottom ? vp.h - margin - hh : margin + hh };
}

export interface PlaceOptions {
  /** Minimum distance to the viewport edges. Default 12. */
  margin?: number;
  /** Distance between Clipa's box and the target rect. Default 14. */
  gap?: number;
  order?: readonly Side[];
  /**
   * Room to keep for the speech bubble. A side only wins when a bubble of this size also fits next to Clipa
   * there; if no side offers both, the first side where Clipa herself fits wins.
   */
  reserve?: Size;
}

export interface Placement {
  box: Box;
  /** Side of the target on which Clipa stands. */
  side: Side;
  /** Overlap area with the target. 0 unless the target leaves no room at all. */
  overlap: number;
  /** True when the box had to slide along the target's edge (or be pushed) to stay in the viewport. */
  clamped: boolean;
}

/**
 * Places a box of `size` beside `target`: the first side in `order` (right, left, above, below) where it
 * fits inside the viewport with `margin`. It is centred on the target along that side, then slid to stay
 * inside the viewport; sliding never brings it closer to the target, so it cannot overlap it. When no side
 * fits (a target that fills the viewport) the side with the smallest overlap wins and `overlap` says how much.
 */
export function placeBeside(target: Box, size: Size, vp: Size, options: PlaceOptions = {}): Placement {
  const margin = options.margin ?? 12;
  const gap = options.gap ?? 14;
  const order = options.order ?? DEFAULT_SIDE_ORDER;
  const maxX = Math.max(margin, vp.w - margin - size.w);
  const maxY = Math.max(margin, vp.h - margin - size.h);
  // Centre on the part of the target that is on screen, so a tall element scrolled half out of view still works.
  const visible = intersection(target, { x: 0, y: 0, w: vp.w, h: vp.h }) ?? target;
  const mid = center(visible);

  let best: Placement | null = null;
  let firstFit: Placement | null = null;
  for (const side of order) {
    const horizontal = side === 'right' || side === 'left';
    let x = mid.x - size.w / 2;
    let y = mid.y - size.h / 2;
    if (side === 'right') x = target.x + target.w + gap;
    else if (side === 'left') x = target.x - gap - size.w;
    else if (side === 'top') y = target.y - gap - size.h;
    else y = target.y + target.h + gap;

    const mainFits = horizontal ? x >= margin && x <= maxX : y >= margin && y <= maxY;
    const slid = horizontal ? { x, y: clamp(y, margin, maxY) } : { x: clamp(x, margin, maxX), y };
    if (mainFits) {
      const box = { x: slid.x, y: slid.y, w: size.w, h: size.h };
      const placement = { box, side, overlap: overlapArea(box, target), clamped: slid.x !== x || slid.y !== y };
      if (!options.reserve || placeBubble(box, target, options.reserve, vp, { margin }).overlap === 0) return placement;
      firstFit ??= placement;
      continue;
    }
    const box = { x: clamp(slid.x, margin, maxX), y: clamp(slid.y, margin, maxY), w: size.w, h: size.h };
    const overlap = overlapArea(box, target);
    if (best === null || overlap < best.overlap) best = { box, side, overlap, clamped: true };
  }
  if (firstFit !== null) return firstFit;
  if (best === null) throw new Error('placeBeside: empty side order');
  return best;
}

export interface BubblePlacement {
  box: Box;
  /** Side of Clipa on which the bubble sits; the bubble's tail faces the opposite way. */
  side: Side;
  overlap: number;
}

/** Sides of Clipa ordered so that the bubble goes away from the target first and toward it last. */
export function sidesAwayFrom(actor: Box, target: Box | null): Side[] {
  if (target === null) return ['top', 'left', 'bottom', 'right'];
  const a = center(actor);
  const t = center(target);
  const dx = a.x - t.x;
  const dy = a.y - t.y;
  const horizontal: Side = dx >= 0 ? 'right' : 'left';
  const vertical: Side = dy >= 0 ? 'bottom' : 'top';
  const againstH: Side = horizontal === 'right' ? 'left' : 'right';
  const againstV: Side = vertical === 'bottom' ? 'top' : 'bottom';
  return Math.abs(dx) >= Math.abs(dy)
    ? [horizontal, vertical, againstV, againstH]
    : [vertical, horizontal, againstH, againstV];
}

/**
 * Places the speech bubble next to Clipa, on a side that is inside the viewport and clear of the target
 * (kept `clearance` away from it). On each side the bubble is centred on Clipa first; when that would touch
 * the target it slides along Clipa's edge to just past the target, as long as it still sits against her.
 * Falls back to the placement with the least overlap.
 */
export function placeBubble(
  actor: Box,
  target: Box | null,
  bubble: Size,
  vp: Size,
  options: { margin?: number; gap?: number; clearance?: number } = {},
): BubblePlacement {
  const margin = options.margin ?? 12;
  const gap = options.gap ?? 10;
  const clearance = options.clearance ?? 8;
  const keepOut = target === null ? null : inflate(target, clearance);
  const maxX = Math.max(margin, vp.w - margin - bubble.w);
  const maxY = Math.max(margin, vp.h - margin - bubble.h);
  const a = center(actor);

  let best: BubblePlacement | null = null;
  for (const side of sidesAwayFrom(actor, target)) {
    const horizontal = side === 'left' || side === 'right';
    let mainPos: number;
    if (side === 'right') mainPos = actor.x + actor.w + gap;
    else if (side === 'left') mainPos = actor.x - gap - bubble.w;
    else if (side === 'top') mainPos = actor.y - gap - bubble.h;
    else mainPos = actor.y + actor.h + gap;
    const mainMax = horizontal ? maxX : maxY;
    const crossMax = horizontal ? maxY : maxX;
    const crossLen = horizontal ? bubble.h : bubble.w;
    const actorLo = horizontal ? actor.y : actor.x;
    const actorHi = actorLo + (horizontal ? actor.h : actor.w);
    const mid = horizontal ? a.y : a.x;
    const crossCandidates = [mid - crossLen / 2];
    if (keepOut) {
      crossCandidates.push(
        horizontal ? keepOut.y + keepOut.h : keepOut.x + keepOut.w,
        (horizontal ? keepOut.y : keepOut.x) - crossLen,
      );
    }
    for (const wanted of crossCandidates) {
      const cross = clamp(wanted, margin, crossMax);
      // It must still sit against Clipa: the bubble's span along her edge has to overlap hers.
      if (cross >= actorHi || cross + crossLen <= actorLo) continue;
      const box = horizontal
        ? { x: clamp(mainPos, margin, mainMax), y: cross, w: bubble.w, h: bubble.h }
        : { x: cross, y: clamp(mainPos, margin, mainMax), w: bubble.w, h: bubble.h };
      const hit = keepOut === null ? 0 : overlapArea(box, keepOut);
      const onActor = overlapArea(box, actor);
      // The main-axis position must be the requested one: a pushed box would sit on Clipa or the target.
      const exact = Math.abs((horizontal ? box.x : box.y) - mainPos) < 0.5;
      const penalty = hit + onActor + (exact ? 0 : 1e6);
      if (penalty === 0) return { box, side, overlap: 0 };
      if (best === null || penalty < best.overlap) best = { box, side, overlap: penalty };
    }
  }
  if (best === null) {
    // Nothing attached to Clipa was possible (a bubble wider than the viewport): centre it above her.
    const box = {
      x: clamp(a.x - bubble.w / 2, margin, maxX),
      y: clamp(actor.y - gap - bubble.h, margin, maxY),
      w: bubble.w,
      h: bubble.h,
    };
    return { box, side: 'top', overlap: overlapArea(box, actor) + (keepOut === null ? 0 : overlapArea(box, keepOut)) };
  }
  return best;
}

/** Flight time by distance, clamped to the spec's 600-900 ms. */
export function flightDuration(distance: number): number {
  return clamp(Math.round(520 + 0.28 * distance), FLIGHT_MIN_MS, FLIGHT_MAX_MS);
}

export function easeInOutCubic(t: number): number {
  const c = clamp(t, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface FlightPath {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
}

export function bezierPoint(path: FlightPath, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * path.p0.x + b * path.p1.x + c * path.p2.x + d * path.p3.x,
    y: a * path.p0.y + b * path.p1.y + c * path.p2.y + d * path.p3.y,
  };
}

export interface PathOptions {
  /** Rects the flight must not cross (the targets it leaves and approaches). */
  obstacles?: readonly Box[];
  /** Half size of Clipa's box at full scale, used for the sweep test. */
  half: Size;
  /** Scale at the start and at the end of the flight (docked is 0.7); it is blended along the path. Default 1. */
  scaleFrom?: number;
  scaleTo?: number;
  viewport?: Size;
  /** Extra distance kept from the obstacles. Default 6. */
  clearance?: number;
}

const SAMPLES = 48;

/** Number of sampled positions along the path where Clipa would sit on an obstacle or leave the viewport. */
export function pathViolations(path: FlightPath, options: PathOptions): number {
  const clearance = options.clearance ?? 6;
  const keepOut = (options.obstacles ?? []).map((o) => inflate(o, clearance));
  const s0 = options.scaleFrom ?? 1;
  const s1 = options.scaleTo ?? 1;
  let bad = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    const scale = lerp(s0, s1, u);
    const box = boxAt(bezierPoint(path, u), { w: options.half.w * 2 * scale, h: options.half.h * 2 * scale });
    if (keepOut.some((k) => overlaps(box, k))) bad++;
    else if (options.viewport && !insideViewport(box, options.viewport)) bad++;
  }
  return bad;
}

/** Bow sizes (fraction of the distance, sign = side) and where along the chord the two control points sit. */
const BOWS = [0.22, -0.22, 0.4, -0.4, 0.65, -0.65, 1, -1] as const;
const SHAPES = [
  [0.28, 0.72],
  [0.12, 0.62],
  [0.38, 0.88],
] as const;

/**
 * A cubic bezier from `from` to `to`. It bows to one side like a hop; the upward bow is tried first, then
 * the other side, then wider arcs and arcs that lift early or late, and the first path that neither crosses
 * an obstacle nor leaves the viewport wins. When none is clean, the one with the fewest bad samples is used.
 */
export function planFlightPath(from: Pt, to: Pt, options: PathOptions): FlightPath {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { p0: from, p1: from, p2: to, p3: to };
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const build = (k: number, t1: number, t2: number): FlightPath => {
    const bow = Math.min(Math.abs(k) * len, 360) * Math.sign(k);
    return {
      p0: from,
      p1: { x: from.x + dx * t1 + nx * bow, y: from.y + dy * t1 + ny * bow },
      p2: { x: from.x + dx * t2 + nx * bow, y: from.y + dy * t2 + ny * bow },
      p3: to,
    };
  };
  let best: FlightPath | null = null;
  let bestScore = Infinity;
  for (const k of BOWS) {
    for (const [t1, t2] of SHAPES) {
      const path = build(k, t1, t2);
      const score = pathViolations(path, options);
      if (score === 0) return path;
      if (score < bestScore) {
        best = path;
        bestScore = score;
      }
    }
  }
  return best ?? build(0.22, 0.28, 0.72);
}

/** Unit vector from `from` toward `to` (zero when they coincide); used to turn the eyes. */
export function lookVector(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-6 ? { x: 0, y: 0 } : { x: dx / len, y: dy / len };
}

export type PointDirection = 'up-left' | 'left' | 'down-left' | 'up-right' | 'right' | 'down-right';

/** Which of the six arm poses of the character aims from `from` at `to`. */
export function pointDirection(from: Pt, to: Pt): PointDirection {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = dx < 0 ? 'left' : 'right';
  if (Math.abs(dy) < 0.4 * Math.abs(dx)) return side;
  return dy < 0 ? (side === 'left' ? 'up-left' : 'up-right') : side === 'left' ? 'down-left' : 'down-right';
}
