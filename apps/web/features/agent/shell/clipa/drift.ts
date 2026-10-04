// Clipa near the cursor: while she rests at home (the director's dock), she drifts a little toward the mouse, heavily damped
// and never more than DRIFT.maxPx from her resting spot. Anything that moves her (a point, an ask, a warning, an attention
// flash) takes over: the offset eases back to zero while she is not docked or while the drift is held. prefers-reduced-motion:
// no drift at all. The offset goes on the actor's CSS `translate`, which composes with the director's own `transform`.
// The math is pure (unit-tested); startDrift() binds it to the page.

export const DRIFT = {
  /** The switch: false and Clipa stays exactly where the director puts her. */
  enabled: true,
  /** At most this far from her resting spot. */
  maxPx: 48,
  /** The share of the distance to the cursor she would follow (before the cap): a far cursor pulls her to the cap. */
  follow: 0.1,
  /** Time constant of the damping: about this long to cover two thirds of the way. */
  tauMs: 650,
  /** Offsets this close count as there: no sub-pixel jitter, and the loop stops. */
  settlePx: 0.3,
} as const;

export interface Pt { x: number; y: number }

/** The offset she drifts toward: the direction of the cursor from her resting spot, capped at maxPx; zero without a cursor. */
export function driftTarget(rest: Pt, cursor: Pt | null, maxPx: number = DRIFT.maxPx, follow: number = DRIFT.follow): Pt {
  if (cursor === null) return { x: 0, y: 0 };
  const dx = cursor.x - rest.x;
  const dy = cursor.y - rest.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: 0, y: 0 };
  const len = Math.min(maxPx, dist * follow);
  return { x: (dx / dist) * len, y: (dy / dist) * len };
}

/** One damped step from `offset` toward `target` over dtMs (exponential smoothing: no overshoot, no oscillation). */
export function driftStep(offset: Pt, target: Pt, dtMs: number, tauMs: number = DRIFT.tauMs): Pt {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return { x: offset.x + (target.x - offset.x) * k, y: offset.y + (target.y - offset.y) * k };
}

export interface DriftDeps {
  win: Window;
  /** The element the director moves (Clipa's actor). */
  actor(): HTMLElement | null;
  /** True while she rests at home and nothing else moves her. */
  resting(): boolean;
}

export interface DriftHandle {
  /** Something changed (the director's state): ease toward the new target. */
  wake(): void;
  /** Keep her still (offset back to zero) for this long: an attention flash in place. */
  hold(ms: number): void;
  dispose(): void;
}

export function startDrift(deps: DriftDeps): DriftHandle {
  const { win } = deps;
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
  let cursor: Pt | null = null;
  let offset: Pt = { x: 0, y: 0 };
  let frame = 0;
  let last = 0;
  let heldUntil = 0;
  const apply = (el: HTMLElement): void => {
    const still = Math.abs(offset.x) < DRIFT.settlePx && Math.abs(offset.y) < DRIFT.settlePx;
    el.style.translate = still ? '' : `${offset.x.toFixed(1)}px ${offset.y.toFixed(1)}px`;
  };
  const loop = (now: number): void => {
    frame = 0;
    const el = deps.actor();
    if (el === null) return;
    const dt = last === 0 ? 16 : Math.min(64, now - last);
    last = now;
    const free = DRIFT.enabled && !reduced.matches && deps.resting() && now >= heldUntil;
    let target: Pt = { x: 0, y: 0 };
    if (free && cursor !== null) {
      const r = el.getBoundingClientRect();
      // Her resting spot: where the director has her, without the drift itself.
      target = driftTarget({ x: r.left + r.width / 2 - offset.x, y: r.top + r.height / 2 - offset.y }, cursor);
    }
    offset = driftStep(offset, target, dt);
    if (Math.hypot(target.x - offset.x, target.y - offset.y) < DRIFT.settlePx) offset = target;
    apply(el);
    // Frames only while she moves: the cursor, a hold or a change of the director's state wakes the loop again.
    if (offset.x !== target.x || offset.y !== target.y) frame = win.requestAnimationFrame(loop);
    else last = 0;
  };
  const wake = (): void => { if (frame === 0) frame = win.requestAnimationFrame(loop); };
  const onMove = (e: PointerEvent): void => { cursor = { x: e.clientX, y: e.clientY }; wake(); };
  const onLeave = (): void => { cursor = null; wake(); };
  win.addEventListener('pointermove', onMove, { passive: true });
  win.document.documentElement.addEventListener('pointerleave', onLeave);
  win.addEventListener('blur', onLeave);
  return {
    wake,
    hold(ms) { heldUntil = Math.max(heldUntil, win.performance.now() + ms); wake(); win.setTimeout(wake, ms + 20); },
    dispose() {
      if (frame !== 0) win.cancelAnimationFrame(frame);
      frame = 0;
      win.removeEventListener('pointermove', onMove);
      win.document.documentElement.removeEventListener('pointerleave', onLeave);
      win.removeEventListener('blur', onLeave);
      const el = deps.actor();
      if (el !== null) el.style.translate = '';
    },
  };
}
