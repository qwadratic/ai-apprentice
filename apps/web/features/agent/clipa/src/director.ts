/*
 * The Clipa director: puts one <clipa-buddy> on the page and moves it through the lifecycle of the spec
 * (Dock, Notice, Approach, Speaking, Listening, Thinking, Ack, Retreat, Warning, Pointing, Off).
 *
 *   const clipa = createClipaDirector({ root: document.body, dock: 'bottom-right', resolveTarget, isInputActive });
 *   await clipa.apply(brainDecision);            // or the commands below, one by one
 *
 * Rules it enforces (the spec's "movement rules"):
 *   - Clipa never starts a flight while isInputActive() is true: she waits, and after inputGiveUpMs she gives up
 *     and stays docked. Out at a target she goes back to the dock when the person starts typing while she listens.
 *   - She lands beside the target element, never on it (right, then left, above, below), inside the viewport.
 *   - One flight per question: a second approach while she is out is queued (one slot, the newest wins) and runs
 *     after she is back at the dock. A warning is urgent and preempts instead of queueing.
 *   - Illegal commands are ignored and logged; turning off-record on cancels everything and sends her home asleep.
 *   - prefers-reduced-motion: no flight, she fades out where she is and fades in at the destination.
 *
 * The layer is position: fixed over the viewport, so `root` should be an element for which that holds (normally
 * document.body) and targets are rects in viewport coordinates (getBoundingClientRect). It never takes pointer events.
 *
 * Home: the dock corner, unless the page offers an anchor (by default the first [data-clipa-dock] element, the
 * current stage of the shell's journey rail). On a visible anchor she rests on it, as tall as it and fully opaque,
 * and when the anchor moves (the stage changes) she glides after it.
 */
import { defineClipaBuddy } from './buddy.ts';
import type { ClipaBuddyElement } from './buddy.ts';
import {
  NOTICE_MS,
  RETREAT_MS,
  anchorRest,
  anchorVisible,
  bezierPoint,
  boxAt,
  boxFromRect,
  center,
  dockCenter,
  easeInOutCubic,
  flightDuration,
  lerp,
  lookVector,
  placeBeside,
  placeBubble,
  planFlightPath,
  pointDirection,
} from './geometry.ts';
import type { Box, Pt, Side, Size } from './geometry.ts';
import { canTransition, createMachine, isActive } from './machine.ts';
import { estimateSpeechMs, planDecision } from './plan.ts';
import type {
  ClipaDecision,
  ClipaDock,
  ClipaEvent,
  ClipaFailure,
  ClipaLogEntry,
  ClipaLogKind,
  ClipaResult,
  ClipaState,
  ClipaStep,
  ClipaTarget,
  FlightKind,
  RectLike,
} from './types.ts';

export interface ClipaDirectorOptions {
  /** Where the layer is appended; normally document.body. */
  root: HTMLElement;
  /** Corner Clipa rests in. Default 'bottom-right'. */
  dock?: ClipaDock;
  /**
   * The element Clipa rests on instead of the corner, asked again whenever her home is needed: on a visible anchor she
   * sits centred on it, as tall as it, and she glides after it when it moves. Default: the first [data-clipa-dock]
   * element under the document. null: always the corner.
   */
  dockAnchor?: (() => RectLike | null) | null;
  /** Viewport rect of the element a target names, or null when it is not on screen. Called again before each flight. */
  resolveTarget(target: ClipaTarget): RectLike | null;
  /** True while the person types (or moves the mouse near the target). Clipa never starts a flight then. */
  isInputActive(): boolean;
  /** Height of Clipa at full size in px. Default 96. */
  size?: number;
  /** Minimum distance to the viewport edges. Default 12. */
  margin?: number;
  /** Distance between Clipa and the target rect. Default 14. */
  gap?: number;
  /** How long a flight waits for the person to stop typing before it gives up. Default 8000. */
  inputGiveUpMs?: number;
  /** Typing for this long while she is out sends her back to the dock. Default 700. */
  typingRetreatMs?: number;
  /** An active Clipa that nobody talks to for this long goes home by herself. Default 45000. */
  lingerMs?: number;
  /** Text of the small bubble that goes with the nod. Default "Noted". */
  ackText?: string;
  /** 'auto' follows prefers-reduced-motion; true or false forces it. Default 'auto'. */
  reducedMotion?: 'auto' | boolean;
  /** Receives every log entry. Without it, illegal commands go to console.warn. */
  onLog?(entry: ClipaLogEntry): void;
}

export interface ClipaSpeakOptions {
  /**
   * How long the mouth moves. With it the promise resolves when the speech is over, and Clipa then listens
   * (unless listenAfter is false). Without it the promise resolves once the bubble is up and she keeps talking
   * until the next command, for a voice layer that reports when the agent stops speaking.
   */
  durationMs?: number;
  listenAfter?: boolean;
}

export type ClipaApplyResult = ClipaResult & { steps: readonly ClipaStep[] };

export interface ClipaDirector {
  readonly state: ClipaState;
  /** The last 200 log entries, oldest first. */
  readonly log: readonly ClipaLogEntry[];
  /** The <clipa-buddy> element, for styling or tests. */
  readonly element: ClipaBuddyElement;
  /** Eyes turn to the target for 0.3 s. Dock -> Notice. */
  notice(target: ClipaTarget): Promise<ClipaResult>;
  /** Notice, then a curved flight beside the target. Waits while input is active. */
  approach(target: ClipaTarget): Promise<ClipaResult>;
  /** Bubble with the text and a talking mouth; in Warning and Pointing only the bubble. */
  speak(text: string, options?: ClipaSpeakOptions): Promise<ClipaResult>;
  /** Listening pose; the rings follow `level` (0..1) when given. Call it per VAD frame. */
  listen(level?: number): Promise<ClipaResult>;
  think(): Promise<ClipaResult>;
  /** Nod and a short "Noted", then back to the dock. */
  ack(): Promise<ClipaResult>;
  /** Back to the dock corner in 500 ms. */
  retreat(): Promise<ClipaResult>;
  /** Warning pose beside the target (the Send button). Preempts; without a target she warns in place. */
  warn(target?: ClipaTarget): Promise<ClipaResult>;
  /** Pointing arm beside the target (the replay of the expert's moment). */
  point(target?: ClipaTarget): Promise<ClipaResult>;
  /** Off the record: grey, eyes closed, home. Cancels everything in progress. */
  setOff(off: boolean): Promise<ClipaResult>;
  /** Plays the sequence of a BrainDecision; resolves when it has run (not when the person has answered). */
  apply(decision: ClipaDecision, options?: { durationMs?: number }): Promise<ClipaApplyResult>;
  setReducedMotion(mode: 'auto' | boolean): void;
  /** Resolves when Clipa is docked (or off), not flying and nothing is queued. */
  idle(): Promise<void>;
  subscribe(listener: (event: ClipaEvent) => void): () => void;
  destroy(): void;
}

interface Pose {
  cx: number;
  cy: number;
  scale: number;
  opacity: number;
}

const DOCK_SCALE = 0.7;
const DOCK_OPACITY = 0.45;
/** On an anchor (the journey rail) she is the stage marker, so she is not faded. */
const ANCHOR_OPACITY = 1;
/** The attribute that marks the default anchor. */
export const DOCK_ANCHOR_ATTR = 'data-clipa-dock';
/** A glide after the anchor: never shorter than this. */
const FOLLOW_MIN_MS = 420;
const OFF_OPACITY = 0.5;
const ACK_MS = 900;
const WAKE_MS = 320;
const SETTLE_MS = 320;
const QUIET_POLL_MS = 100;
const TICK_MS = 120;
const BLINK_MIN_MS = 6000;
const BLINK_MAX_MS = 9000;
const BUBBLE_MAX_CHARS = 280;
const BLEED = 6;
/** Room kept for the bubble when choosing the side she lands on: three lines at the widest. */
const BUBBLE_RESERVE: Size = { w: 264, h: 100 };

const LAYER_CSS = `
.clipa-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; overflow: visible;
  --clipa-bubble-bg: #12302c; --clipa-bubble-ink: #f4fbfa; --clipa-warn-bg: #f5a524; --clipa-warn-ink: #2b1a00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .clipa-layer { --clipa-bubble-bg: #e9f7f4; --clipa-bubble-ink: #10302c; } }
:root[data-theme="dark"] .clipa-layer { --clipa-bubble-bg: #e9f7f4; --clipa-bubble-ink: #10302c; }
.clipa-actor { position: absolute; left: 0; top: 0; transform-origin: 50% 50%; will-change: transform, opacity; }
.clipa-actor clipa-buddy { display: block; }
.clipa-bubble { position: absolute; left: 0; top: 0; width: max-content; max-width: min(264px, calc(100vw - 24px));
  opacity: 0; visibility: hidden; transition: opacity 0.18s ease, visibility 0s linear 0.18s; }
.clipa-bubble.on { opacity: 1; visibility: visible; transition: opacity 0.18s ease, transform 0.3s ease; }
.clipa-bubble .box { position: relative; padding: 9px 12px; border-radius: 12px; overflow-wrap: anywhere;
  background: var(--clipa-bubble-bg); color: var(--clipa-bubble-ink);
  font: 600 15px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  transform: scale(0.92); transform-origin: var(--ox, 50%) var(--oy, 50%); transition: transform 0.22s cubic-bezier(0.3, 1.4, 0.5, 1); }
.clipa-bubble.on .box { transform: none; }
.clipa-bubble[data-variant="warn"] .box { background: var(--clipa-warn-bg); color: var(--clipa-warn-ink); }
.clipa-bubble[data-variant="ack"] .box { padding: 5px 11px; font-size: 14px; }
.clipa-bubble .box::after { content: ""; position: absolute; width: 10px; height: 10px; border-radius: 2px; background: inherit; transform: rotate(45deg); }
.clipa-bubble[data-tail="left"] .box::after { left: -4px; top: calc(var(--tail, 50%) - 5px); }
.clipa-bubble[data-tail="right"] .box::after { right: -4px; top: calc(var(--tail, 50%) - 5px); }
.clipa-bubble[data-tail="top"] .box::after { top: -4px; left: calc(var(--tail, 50%) - 5px); }
.clipa-bubble[data-tail="bottom"] .box::after { bottom: -4px; left: calc(var(--tail, 50%) - 5px); }
.clipa-bubble[data-tail="left"] .box { --ox: 0%; --oy: var(--tail); }
.clipa-bubble[data-tail="right"] .box { --ox: 100%; --oy: var(--tail); }
.clipa-bubble[data-tail="top"] .box { --ox: var(--tail); --oy: 0%; }
.clipa-bubble[data-tail="bottom"] .box { --ox: var(--tail); --oy: 100%; }
@media (prefers-reduced-motion: reduce) {
  .clipa-bubble .box { transform: none; transition: none; }
  .clipa-bubble.on { transition: opacity 0.12s linear; }
}
.clipa-layer[data-reduced] .clipa-bubble .box { transform: none; transition: none; }
.clipa-layer[data-reduced] .clipa-bubble.on { transition: opacity 0.12s linear; }
`;

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export function createClipaDirector(options: ClipaDirectorOptions): ClipaDirector {
  defineClipaBuddy();
  const doc = options.root.ownerDocument;
  const win = doc.defaultView ?? window;

  const dock: ClipaDock = options.dock ?? 'bottom-right';
  const heightPx = options.size ?? 96;
  const margin = options.margin ?? 12;
  const gap = options.gap ?? 14;
  const giveUpMs = options.inputGiveUpMs ?? 8000;
  const typingRetreatMs = options.typingRetreatMs ?? 700;
  const lingerMs = options.lingerMs ?? 45000;
  const ackText = options.ackText ?? 'Noted';

  const body: Size = { w: heightPx * 0.8, h: heightPx };
  const hit: Size = { w: body.w + 2 * BLEED, h: body.h + 2 * BLEED };

  // DOM: one fixed layer with the actor (the buddy) and the bubble.
  const layer = doc.createElement('div');
  layer.className = 'clipa-layer';
  const style = doc.createElement('style');
  style.textContent = LAYER_CSS;
  const actor = doc.createElement('div');
  actor.className = 'clipa-actor';
  actor.style.width = `${body.w}px`;
  actor.style.height = `${body.h}px`;
  actor.setAttribute('aria-hidden', 'true');
  const buddy = doc.createElement('clipa-buddy');
  buddy.setAttribute('size', String(heightPx));
  buddy.setAttribute('manual-blink', '');
  actor.append(buddy);
  const bubble = doc.createElement('div');
  bubble.className = 'clipa-bubble';
  bubble.setAttribute('role', 'status');
  const bubbleBox = doc.createElement('div');
  bubbleBox.className = 'box';
  bubble.append(bubbleBox);
  layer.append(style, actor, bubble);
  options.root.append(layer);

  const machine = createMachine('dock');
  const logs: ClipaLogEntry[] = [];
  const listeners = new Set<(event: ClipaEvent) => void>();
  const wakers = new Set<() => void>();
  const idleWaiters: Array<() => void> = [];
  const timers = new Set<number>();

  let destroyed = false;
  let gen = 0;
  let cancelReason: ClipaFailure = 'cancelled';
  let startingRun: number | null = null;
  /** True between taking the queued command out of its slot and starting it (a short settle delay). */
  let draining = false;
  let pending: { kind: string; run: () => Promise<ClipaResult>; resolve: (r: ClipaResult) => void } | null = null;
  let current: { target: ClipaTarget; box: Box } | null = null;
  let lastTouch = 0;
  let typingSince = 0;
  let noticeStartedAt = 0;
  let flying = false;
  let moveToken = 0;
  let moving: Promise<boolean> = Promise.resolve(true);
  let reducedPref: 'auto' | boolean = options.reducedMotion ?? 'auto';
  const reducedQuery = win.matchMedia('(prefers-reduced-motion: reduce)');

  const now = (): number => win.performance.now();
  const ok: ClipaResult = { ok: true };
  const fail = (reason: ClipaFailure): ClipaResult => ({ ok: false, reason });
  const isReduced = (): boolean => (reducedPref === 'auto' ? reducedQuery.matches : reducedPref);
  const viewport = (): Size => {
    const root = doc.documentElement;
    return { w: root.clientWidth || win.innerWidth, h: root.clientHeight || win.innerHeight };
  };
  const anchorRect: () => RectLike | null =
    options.dockAnchor === null
      ? () => null
      : options.dockAnchor ??
        (() => {
          const el = doc.querySelector(`[${DOCK_ANCHOR_ATTR}]`);
          return el === null ? null : el.getBoundingClientRect();
        });
  /** The anchor as a box when Clipa can rest on it now, or null (then the corner). */
  const anchorBox = (): Box | null => {
    let rect: RectLike | null = null;
    try {
      rect = anchorRect();
    } catch {
      rect = null;
    }
    if (rect === null) return null;
    const box = boxFromRect(rect);
    return anchorVisible(box, viewport()) ? box : null;
  };

  function emit(event: ClipaEvent): void {
    for (const listener of [...listeners]) listener(event);
  }
  function log(kind: ClipaLogKind, message: string): void {
    const entry: ClipaLogEntry = { at: now(), kind, message };
    logs.push(entry);
    if (logs.length > 200) logs.shift();
    emit({ type: 'log', entry });
    if (options.onLog) options.onLog(entry);
    else if (kind === 'illegal') console.warn(`[clipa] ${message}`);
  }
  function later(fn: () => void, ms: number): number {
    const id = win.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  // ---- pose and flight -------------------------------------------------------------------------------------

  const dockPose = (): Pose => {
    const anchor = anchorBox();
    if (anchor !== null) {
      const rest = anchorRest(anchor, viewport(), body, margin);
      return { cx: rest.center.x, cy: rest.center.y, scale: rest.scale, opacity: machine.state === 'off' ? OFF_OPACITY : ANCHOR_OPACITY };
    }
    const c = dockCenter(dock, viewport(), body, DOCK_SCALE, margin);
    return { cx: c.x, cy: c.y, scale: DOCK_SCALE, opacity: machine.state === 'off' ? OFF_OPACITY : DOCK_OPACITY };
  };
  /** Full size, still at home (the corner or the anchor): she stands up where she is (speak or listen without a target). */
  const wakePose = (): Pose => {
    const anchor = anchorBox();
    if (anchor !== null) {
      const rest = anchorRest(anchor, viewport(), hit, margin, 1);
      return { cx: rest.center.x, cy: rest.center.y, scale: 1, opacity: 1 };
    }
    const c = dockCenter(dock, viewport(), hit, 1, margin);
    return { cx: c.x, cy: c.y, scale: 1, opacity: 1 };
  };
  const standingAt = (c: Pt): Pose => ({ cx: c.x, cy: c.y, scale: 1, opacity: 1 });

  let pose: Pose = dockPose();
  function render(): void {
    const x = pose.cx - body.w / 2;
    const y = pose.cy - body.h / 2;
    actor.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${pose.scale.toFixed(4)})`;
    actor.style.opacity = pose.opacity.toFixed(3);
  }
  render();

  const actorBox = (): Box => boxAt({ x: pose.cx, y: pose.cy }, { w: hit.w * pose.scale, h: hit.h * pose.scale });

  function tween(ms: number, token: number, step: (t: number) => void): Promise<boolean> {
    return new Promise((resolve) => {
      if (doc.hidden || ms <= 0) {
        if (token === moveToken) step(1);
        resolve(token === moveToken);
        return;
      }
      const t0 = now();
      const frame = (): void => {
        if (token !== moveToken || destroyed) {
          resolve(false);
          return;
        }
        const t = clamp((now() - t0) / ms, 0, 1);
        step(t);
        if (t >= 1) resolve(true);
        else win.requestAnimationFrame(frame);
      };
      win.requestAnimationFrame(frame);
    });
  }

  const blend = (a: Pose, b: Pose, e: number): Pose => ({
    cx: lerp(a.cx, b.cx, e),
    cy: lerp(a.cy, b.cy, e),
    scale: lerp(a.scale, b.scale, e),
    opacity: lerp(a.opacity, b.opacity, e),
  });

  /** Moves from the current pose to `dest`. Resolves true on arrival, false when another move took over. */
  function moveTo(dest: Pose, kind: FlightKind, obstacles: readonly Box[], durationMs?: number): Promise<boolean> {
    const token = ++moveToken;
    const from = { ...pose };
    const dist = Math.hypot(dest.cx - from.cx, dest.cy - from.cy);
    const inPlace = dist < 2;
    const homeward = kind === 'retreat' || kind === 'off';
    const reduced = isReduced();
    let plannedMs = WAKE_MS;
    if (inPlace) plannedMs = homeward ? 300 : WAKE_MS;
    else if (homeward) plannedMs = RETREAT_MS;
    else if (kind === 'settle') plannedMs = SETTLE_MS;
    else plannedMs = flightDuration(dist);
    if (durationMs !== undefined && !inPlace) plannedMs = durationMs;

    flying = !inPlace;
    syncBuddy();
    const startedAt = now();
    emit({ type: 'flight', at: startedAt, phase: 'start', kind, durationMs: plannedMs, reduced });

    const run = async (): Promise<boolean> => {
      if (reduced) {
        if (inPlace) {
          return tween(150, token, (t) => {
            pose = blend(from, dest, t);
            render();
          });
        }
        const faded = await tween(140, token, (t) => {
          pose = { ...from, opacity: lerp(from.opacity, 0, t) };
          render();
        });
        if (!faded) return false;
        pose = { ...dest, opacity: 0 };
        render();
        return tween(220, token, (t) => {
          pose = { ...dest, opacity: lerp(0, dest.opacity, t) };
          render();
        });
      }
      if (inPlace) {
        return tween(plannedMs, token, (t) => {
          pose = blend(from, dest, easeInOutCubic(t));
          render();
        });
      }
      const path = planFlightPath(
        { x: from.cx, y: from.cy },
        { x: dest.cx, y: dest.cy },
        { obstacles, half: { w: hit.w / 2, h: hit.h / 2 }, scaleFrom: from.scale, scaleTo: dest.scale, viewport: viewport() },
      );
      const dirX = clamp((dest.cx - from.cx) / dist, -1, 1);
      const arrived = await tween(plannedMs, token, (t) => {
        const e = easeInOutCubic(t);
        const p = bezierPoint(path, e);
        pose = { cx: p.x, cy: p.y, scale: lerp(from.scale, dest.scale, e), opacity: lerp(from.opacity, dest.opacity, e) };
        buddy.style.setProperty('--clipa-fly-lean', `${(dirX * 7 * Math.sin(Math.PI * t)).toFixed(2)}deg`);
        render();
      });
      if (token === moveToken) buddy.style.removeProperty('--clipa-fly-lean');
      return arrived;
    };

    const result = run().then((arrived) => {
      emit({ type: 'flight', at: now(), phase: 'end', kind, durationMs: now() - startedAt, reduced, completed: arrived });
      if (token === moveToken) {
        flying = false;
        syncBuddy();
        checkIdle();
        if (arrived && isActive(machine.state)) scheduleSettle();
      }
      return arrived;
    });
    moving = result;
    return result;
  }

  // ---- buddy visuals, eyes, bubble -------------------------------------------------------------------------

  function syncBuddy(): void {
    const s = machine.state;
    let visual = 'idle';
    if (s === 'speaking' || s === 'listening' || s === 'thinking') visual = s;
    else if (s === 'ack') visual = 'ack';
    else if ((s === 'warning' || s === 'pointing') && !flying) visual = s === 'warning' ? 'warning' : 'pointing';
    if (buddy.getAttribute('state') !== visual) buddy.setAttribute('state', visual);
    if (buddy.hasAttribute('off') !== (s === 'off')) buddy.off = s === 'off';
  }

  function lookAt(box: Box | null): void {
    if (box === null) {
      buddy.clearLook();
      return;
    }
    const v = lookVector({ x: pose.cx, y: pose.cy }, center(box));
    buddy.setLook(v.x, v.y);
  }

  function layoutBubble(): void {
    const size: Size = { w: bubble.offsetWidth, h: bubble.offsetHeight };
    const box = actorBox();
    const placed = placeBubble(box, current ? current.box : null, size, viewport(), { margin });
    const a = center(box);
    const tail =
      placed.side === 'left' || placed.side === 'right'
        ? clamp(a.y - placed.box.y, 16, Math.max(16, size.h - 16))
        : clamp(a.x - placed.box.x, 16, Math.max(16, size.w - 16));
    bubble.style.transform = `translate(${placed.box.x.toFixed(1)}px, ${placed.box.y.toFixed(1)}px)`;
    bubble.dataset['tail'] = OPPOSITE[placed.side];
    bubbleBox.style.setProperty('--tail', `${tail.toFixed(0)}px`);
  }
  function showBubble(text: string, variant: 'say' | 'warn' | 'ack'): void {
    bubbleBox.textContent = text.length > BUBBLE_MAX_CHARS ? `${text.slice(0, BUBBLE_MAX_CHARS - 1)}…` : text;
    bubble.dataset['variant'] = variant;
    layoutBubble();
    // Flush the new position while the bubble is still hidden, so it appears there instead of sliding in from
    // where it was last time (the .on rule transitions transform, for re-layouts of a visible bubble).
    void bubble.offsetWidth;
    bubble.classList.add('on');
  }
  function hideBubble(): void {
    bubble.classList.remove('on');
  }

  // ---- waiting, cancelling, queueing ---------------------------------------------------------------------------

  /** Cancels every sequence that is waiting: their promises resolve with `reason`. Returns the new run id. */
  function bump(reason: ClipaFailure): number {
    gen++;
    cancelReason = reason;
    for (const wake of [...wakers]) wake();
    return gen;
  }

  /** Resolves true after `ms` (or when `endEarly` says so), false when a cancelling command came in meanwhile. */
  function wait(ms: number, run: number, endEarly?: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      let timer = 0;
      let unsubscribe: (() => void) | null = null;
      const finish = (value: boolean): void => {
        win.clearTimeout(timer);
        wakers.delete(cancel);
        if (unsubscribe) unsubscribe();
        resolve(value);
      };
      const cancel = (): void => finish(false);
      wakers.add(cancel);
      if (endEarly) {
        unsubscribe = machine.subscribe(() => {
          if (endEarly()) finish(gen === run);
        });
      }
      timer = win.setTimeout(() => finish(gen === run), ms);
    });
  }

  async function waitQuiet(run: number): Promise<'quiet' | 'gave-up' | 'cancelled'> {
    if (!options.isInputActive()) return 'quiet';
    log('waiting', 'input is active: holding the flight');
    const until = now() + giveUpMs;
    for (;;) {
      if (!(await wait(QUIET_POLL_MS, run))) return 'cancelled';
      if (!options.isInputActive()) {
        log('info', 'input went quiet: flying');
        return 'quiet';
      }
      if (now() >= until) {
        log('gave-up', `input stayed active for ${giveUpMs} ms: staying at the dock`);
        return 'gave-up';
      }
    }
  }

  /** Flights that start from the dock wait their turn while another conversation is on screen. */
  function shouldQueue(): boolean {
    const s = machine.state;
    return startingRun !== null || (s !== 'dock' && s !== 'notice' && s !== 'off');
  }
  function enqueue(kind: string, run: () => Promise<ClipaResult>): Promise<ClipaResult> {
    return new Promise((resolve) => {
      if (pending) {
        log('dropped', `queued ${pending.kind} replaced by ${kind}`);
        pending.resolve(fail('dropped'));
      }
      pending = { kind, run, resolve };
      log('queued', `${kind} waits until Clipa is back at the dock`);
    });
  }
  function dropPending(reason: ClipaFailure): void {
    if (!pending) return;
    pending.resolve(fail(reason));
    pending = null;
  }
  function drain(): void {
    if (!pending || startingRun !== null || machine.state !== 'dock') return;
    const next = pending;
    pending = null;
    draining = true;
    later(() => {
      draining = false;
      void next.run().then(next.resolve);
    }, 200);
  }

  function settled(): boolean {
    return (
      (machine.state === 'dock' || machine.state === 'off') && !flying && pending === null && !draining && startingRun === null
    );
  }
  function checkIdle(): void {
    if (!settled()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function touch(): void {
    lastTouch = now();
  }

  // ---- commands --------------------------------------------------------------------------------------------

  function illegal(command: string, to: ClipaState): ClipaResult {
    const s = machine.state;
    if (s === 'off') {
      log('illegal', `${command} ignored: Clipa is off the record`);
      return fail('off');
    }
    log('illegal', `${command} ignored: ${s} -> ${to} is not a legal transition`);
    return fail('illegal');
  }
  /** Moves the machine to `to`; returns a failure result when that is not legal. */
  function enter(command: string, to: ClipaState): ClipaResult | null {
    if (destroyed) return fail('destroyed');
    return machine.request(to).ok ? null : illegal(command, to);
  }

  async function notice(target: ClipaTarget): Promise<ClipaResult> {
    if (destroyed) return fail('destroyed');
    if (machine.state === 'notice') return ok;
    if (machine.state === 'off') return illegal('notice', 'notice');
    if (shouldQueue()) return enqueue('notice', () => notice(target));
    const rect = options.resolveTarget(target);
    if (!rect) {
      log('ignored', `notice: no element for ${target.surface}${target.hint ? `/${target.hint}` : ''}`);
      return fail('no-target');
    }
    const run = gen;
    const bad = enter('notice', 'notice');
    if (bad) return bad;
    noticeStartedAt = now();
    lookAt(boxFromRect(rect));
    return (await wait(NOTICE_MS, run, () => machine.state !== 'notice')) ? ok : fail(cancelReason);
  }

  async function approach(target: ClipaTarget): Promise<ClipaResult> {
    if (destroyed) return fail('destroyed');
    if (machine.state === 'off') return illegal('approach', 'approach');
    if (shouldQueue()) return enqueue('approach', () => approach(target));
    const run = gen;
    startingRun = run;
    try {
      if (machine.state === 'dock') {
        const quiet = await waitQuiet(run);
        if (quiet !== 'quiet') return quiet === 'gave-up' ? fail('input-active') : fail(cancelReason);
        const first = options.resolveTarget(target);
        if (!first) {
          log('ignored', `approach: no element for ${target.surface}${target.hint ? `/${target.hint}` : ''}`);
          return fail('no-target');
        }
        const bad = enter('approach', 'notice');
        if (bad) return bad;
        noticeStartedAt = now();
        lookAt(boxFromRect(first));
      }
      // Notice dwell: she looks before she moves, so the person can see her turn.
      const left = Math.max(0, NOTICE_MS - (now() - noticeStartedAt));
      if (!(await wait(left, run, () => machine.state !== 'notice'))) return fail(cancelReason);
      if (machine.state !== 'notice') return fail(cancelReason);
      // Take-off: input may have started during the dwell; the target may have moved.
      const quiet = await waitQuiet(run);
      if (quiet !== 'quiet') {
        machine.request('dock');
        buddy.clearLook();
        return quiet === 'gave-up' ? fail('input-active') : fail(cancelReason);
      }
      const rect = options.resolveTarget(target);
      if (!rect) {
        log('ignored', `approach: the element for ${target.surface}${target.hint ? `/${target.hint}` : ''} is gone`);
        machine.request('dock');
        buddy.clearLook();
        return fail('no-target');
      }
      const box = boxFromRect(rect);
      const placed = placeBeside(box, hit, viewport(), { margin, gap, reserve: BUBBLE_RESERVE });
      const bad = enter('approach', 'approach');
      if (bad) return bad;
      current = { target, box };
      lookAt(box);
      const arrived = await moveTo(standingAt(center(placed.box)), 'approach', [box]);
      touch();
      return arrived && gen === run ? ok : fail(cancelReason);
    } finally {
      if (startingRun === run) startingRun = null;
    }
  }

  /** Warning and Pointing: fly beside the target (or stay in place) and take the pose. They preempt. */
  async function stand(command: 'warn' | 'point', to: 'warning' | 'pointing', target?: ClipaTarget): Promise<ClipaResult> {
    if (destroyed) return fail('destroyed');
    const from = machine.state;
    if (from === 'retreat') return enqueue(command, () => stand(command, to, target));
    if (!canTransition(from, to)) return illegal(command, to);
    let box: Box | null = null;
    if (target) {
      const rect = options.resolveTarget(target);
      if (!rect) {
        log('ignored', `${command}: no element for ${target.surface}${target.hint ? `/${target.hint}` : ''}`);
        return fail('no-target');
      }
      box = boxFromRect(rect);
    }
    const run = bump('cancelled');
    startingRun = run;
    try {
      let fly = box !== null;
      if (fly && (from === 'dock' || from === 'notice')) {
        const quiet = await waitQuiet(run);
        if (quiet === 'cancelled') return fail(cancelReason);
        if (quiet === 'gave-up') {
          log('info', `${command}: input still active, showing it in place at the dock`);
          fly = false;
        }
      }
      const bad = enter(command, to);
      if (bad) return bad;
      hideBubble();
      const avoid: Box[] = current ? [current.box] : [];
      let arrived = true;
      if (fly && box && target) {
        // The pointing arm reaches past her box toward the element, so she keeps a little more distance.
        const standOff = to === 'pointing' ? gap + 12 : gap;
        const placed = placeBeside(box, hit, viewport(), { margin, gap: standOff, reserve: BUBBLE_RESERVE });
        avoid.push(box);
        current = { target, box };
        arrived = await moveTo(standingAt(center(placed.box)), command, avoid);
        if (to === 'pointing') buddy.point = pointDirection(center(placed.box), center(box));
      } else if (from === 'dock' || from === 'notice') {
        current = null;
        arrived = await moveTo(wakePose(), 'wake', avoid);
      }
      buddy.clearLook();
      syncBuddy();
      touch();
      return arrived && gen === run ? ok : fail(cancelReason);
    } finally {
      if (startingRun === run) startingRun = null;
    }
  }

  async function speak(text: string, opts: ClipaSpeakOptions = {}): Promise<ClipaResult> {
    if (destroyed) return fail('destroyed');
    const clean = text.trim();
    if (!clean) {
      log('ignored', 'speak: empty text');
      return fail('illegal');
    }
    const run = gen;
    const s = machine.state;
    if (s === 'warning' || s === 'pointing') {
      // In these poses she keeps the pose: only the bubble carries the words.
      await moving;
      if (gen !== run || machine.state !== s) return fail(cancelReason);
      showBubble(clean, s === 'warning' ? 'warn' : 'say');
      touch();
      if (opts.durationMs === undefined) return ok;
      return (await wait(opts.durationMs, run, () => machine.state !== s)) ? ok : fail(cancelReason);
    }
    const bad = enter('speak', 'speaking');
    if (bad) return bad;
    if (s === 'dock') void moveTo(wakePose(), 'wake', []);
    touch();
    await moving;
    if (gen !== run) return fail(cancelReason);
    if (machine.state !== 'speaking') return ok;
    showBubble(clean, 'say');
    if (opts.durationMs === undefined) return ok;
    if (!(await wait(opts.durationMs, run, () => machine.state !== 'speaking'))) return fail(cancelReason);
    if (machine.state === 'speaking' && (opts.listenAfter ?? true)) await listen();
    return ok;
  }

  function listen(level?: number): Promise<ClipaResult> {
    if (destroyed) return Promise.resolve(fail('destroyed'));
    const s = machine.state;
    if (s === 'listening') {
      buddy.level = level === undefined ? null : level;
      if (level !== undefined && level > 0.15) touch();
      return Promise.resolve(ok);
    }
    const bad = enter('listen', 'listening');
    if (bad) return Promise.resolve(bad);
    if (s === 'dock') void moveTo(wakePose(), 'wake', []);
    buddy.level = level === undefined ? null : level;
    touch();
    return Promise.resolve(ok);
  }

  function think(): Promise<ClipaResult> {
    const bad = enter('think', 'thinking');
    if (bad) return Promise.resolve(bad);
    hideBubble();
    buddy.level = null;
    touch();
    return Promise.resolve(ok);
  }

  async function ack(): Promise<ClipaResult> {
    const run = gen;
    const bad = enter('ack', 'ack');
    if (bad) return bad;
    buddy.level = null;
    showBubble(ackText, 'ack');
    touch();
    if (!(await wait(ACK_MS, run, () => machine.state !== 'ack'))) return fail(cancelReason);
    if (machine.state === 'ack') void retreatHome('cancelled');
    return ok;
  }

  async function retreatHome(reason: ClipaFailure): Promise<ClipaResult> {
    if (destroyed) return fail('destroyed');
    const s = machine.state;
    if (s === 'dock' || s === 'off' || s === 'retreat') {
      log('ignored', `retreat ignored: already ${s}`);
      return ok;
    }
    const run = bump(reason);
    hideBubble();
    buddy.level = null;
    buddy.clearLook();
    const avoid = current ? [current.box] : [];
    if (s === 'notice') {
      machine.request('dock');
      return ok;
    }
    machine.request('retreat');
    const arrived = await moveTo(dockPose(), 'retreat', avoid);
    if (!arrived || gen !== run || machine.state !== 'retreat') return fail(cancelReason);
    machine.request('dock');
    return ok;
  }

  async function setOff(off: boolean): Promise<ClipaResult> {
    if (destroyed) return fail('destroyed');
    if (off) {
      if (machine.state === 'off') return ok;
      bump('off');
      dropPending('off');
      hideBubble();
      buddy.level = null;
      buddy.clearLook();
      const avoid = current ? [current.box] : [];
      current = null;
      machine.request('off');
      await moveTo(dockPose(), 'off', avoid);
      return ok;
    }
    if (machine.state !== 'off') return ok;
    machine.request('dock');
    await moveTo(dockPose(), 'wake', []);
    return ok;
  }

  async function runStep(step: ClipaStep, durationMs: number | undefined): Promise<ClipaResult> {
    switch (step.op) {
      case 'notice':
        return notice(step.target);
      case 'approach':
        return approach(step.target);
      case 'warn':
        return stand('warn', 'warning', step.target);
      case 'point':
        return stand('point', 'pointing', step.target);
      case 'speak':
        return speak(step.text, { durationMs: durationMs ?? estimateSpeechMs(step.text), listenAfter: false });
      case 'listen':
        return listen();
      case 'think':
        return think();
      case 'ack':
        return ack();
      case 'retreat':
        return retreatHome('cancelled');
      case 'off':
        return setOff(true);
    }
  }

  async function apply(decision: ClipaDecision, opts: { durationMs?: number } = {}): Promise<ClipaApplyResult> {
    const plan = planDecision(decision);
    if (plan.note) log('info', plan.note);
    for (const step of plan.steps) {
      const result = await runStep(step, opts.durationMs);
      if (!result.ok) return { ...result, steps: plan.steps };
    }
    return { ok: true, steps: plan.steps };
  }

  // ---- watchers: typing while out, linger, layout changes, blinking ---------------------------------------------

  /** At home and the anchor moved (the stage changed, the header reflowed): glide after it. */
  let following = false;
  function followAnchor(): void {
    if (following || !settled() || settleQueued) return;
    const dest = dockPose();
    const dist = Math.hypot(dest.cx - pose.cx, dest.cy - pose.cy);
    if (dist < 3 && Math.abs(dest.scale - pose.scale) < 0.02 && Math.abs(dest.opacity - pose.opacity) < 0.02) return;
    following = true;
    void moveTo(dest, 'settle', [], Math.max(FOLLOW_MIN_MS, flightDuration(dist))).finally(() => {
      following = false;
    });
  }

  function tick(): void {
    if (destroyed) return;
    const s = machine.state;
    if (!isActive(s)) {
      typingSince = 0;
      followAnchor();
      return;
    }
    // Spec: Listening -> Retreat when the person starts typing; the question is deferred.
    if ((s === 'listening' || s === 'approach') && !flying && options.isInputActive()) {
      typingSince = typingSince || now();
      if (now() - typingSince >= typingRetreatMs) {
        typingSince = 0;
        log('deferred', 'the person started typing: back to the dock, the question is deferred');
        void retreatHome('input-active');
        return;
      }
    } else {
      typingSince = 0;
    }
    if (s !== 'speaking' && now() - lastTouch > lingerMs) {
      log('info', 'nobody answered for a long time: back to the dock');
      void retreatHome('cancelled');
    }
  }

  let settleTimer = 0;
  /** A resize or scroll is being waited out: the anchor is not followed until settle() has run. */
  let settleQueued = false;
  function scheduleSettle(): void {
    win.clearTimeout(settleTimer);
    timers.delete(settleTimer);
    settleQueued = true;
    settleTimer = later(() => {
      settleQueued = false;
      void settle();
    }, 140);
  }
  /** The window resized or scrolled: keep Clipa beside the element, or in the corner if she is docked. */
  async function settle(): Promise<void> {
    if (destroyed || flying) return;
    const s = machine.state;
    if (s === 'dock' || s === 'notice' || s === 'off') {
      pose = dockPose();
      render();
      return;
    }
    if (!isActive(s)) return;
    if (!current) {
      pose = { ...wakePose() };
      render();
      layoutBubble();
      return;
    }
    if (options.isInputActive()) {
      scheduleSettle();
      return;
    }
    const rect = options.resolveTarget(current.target);
    if (!rect) return;
    const box = boxFromRect(rect);
    const placed = placeBeside(box, hit, viewport(), { margin, gap, reserve: BUBBLE_RESERVE });
    const dest = standingAt(center(placed.box));
    current = { target: current.target, box };
    if (Math.hypot(dest.cx - pose.cx, dest.cy - pose.cy) >= 3) await moveTo(dest, 'settle', [box]);
    if (bubble.classList.contains('on')) layoutBubble();
  }
  const onLayoutChange = (): void => scheduleSettle();
  win.addEventListener('resize', onLayoutChange);
  win.addEventListener('scroll', onLayoutChange, { capture: true, passive: true });

  const tickTimer = win.setInterval(tick, TICK_MS);
  let blinkTimer = 0;
  function scheduleBlink(): void {
    blinkTimer = win.setTimeout(() => {
      if (destroyed) return;
      if (machine.state !== 'off') buddy.blink();
      scheduleBlink();
    }, BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS));
  }
  scheduleBlink();

  machine.subscribe((from, to) => {
    emit({ type: 'state', at: now(), from, to });
    touch();
    syncBuddy();
    if (to === 'dock') {
      current = null;
      buddy.level = null;
      scheduleSettle();
      drain();
    }
    checkIdle();
  });

  return {
    get state(): ClipaState {
      return machine.state;
    },
    get log(): readonly ClipaLogEntry[] {
      return logs;
    },
    element: buddy,
    notice,
    approach,
    speak,
    listen,
    think,
    ack,
    retreat: () => retreatHome('cancelled'),
    warn: (target) => stand('warn', 'warning', target),
    point: (target) => stand('point', 'pointing', target),
    setOff,
    apply,
    setReducedMotion(mode) {
      reducedPref = mode;
      if (mode === 'auto') delete layer.dataset['reduced'];
      else if (mode) layer.dataset['reduced'] = '';
      else delete layer.dataset['reduced'];
    },
    idle() {
      if (settled()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      if (destroyed) return;
      bump('destroyed');
      destroyed = true;
      moveToken++;
      dropPending('destroyed');
      draining = false;
      for (const id of timers) win.clearTimeout(id);
      timers.clear();
      win.clearInterval(tickTimer);
      win.clearTimeout(blinkTimer);
      win.removeEventListener('resize', onLayoutChange);
      win.removeEventListener('scroll', onLayoutChange, { capture: true });
      layer.remove();
      listeners.clear();
      for (const resolve of idleWaiters.splice(0)) resolve();
    },
  };
}
