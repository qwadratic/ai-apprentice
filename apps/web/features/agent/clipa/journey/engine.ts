/*
 * The journey engine: a small state machine over app events that walks the person through the demo and drives
 * the Clipa director (fly to the step's target, say the line in the bubble).
 *
 *   const journey = createJourney({ director, events: bus, resolveTarget: createDomTargetResolver(document) });
 *   bus.emit({ type: 'session_started', mode: 'learn' });
 *
 * Rules:
 *   - The journey moves forward only on events. Timers are used for exactly two things: the one gentle re-nudge
 *     per step, and retrying a line that was held back while somebody typed or talked.
 *   - While the person types or talks, the agent speaks, or the session is off the record, Clipa is quiet at once:
 *     a flight in progress is dropped, she goes home, and the line waits until it is quiet again.
 *   - When the agent asks a live question Clipa leaves the stage to it; the journey speaks again only after the
 *     director is idle.
 *   - Voice is the shell's job: `onSay(line)` fires when the line goes up in the bubble.
 *   - The current step is stored (try/catch around every access), so a reload resumes where the person was.
 *     Steps that need a live capture rewind to the start, because a reload ends the capture.
 */
import type { ClipaResult, ClipaState, ClipaTarget, RectLike } from '../src/types.ts';
import { capturePath, detectCapabilities } from './capabilities.ts';
import type { CaptureCapabilities, CapturePath } from './capabilities.ts';
import { isJourneyMode, matchesEvent, matchesMode, modeRank } from './events.ts';
import type { JourneyEvent, JourneyEventSource, JourneyMode, ShareFailure } from './events.ts';
import { JOURNEY_STEPS } from './journey.ts';
import type { JourneyPersona, JourneyPhase, JourneyStep, JourneyStepId, JourneyText, JourneyVariant } from './journey.ts';
import { journeyClipaTarget } from './targets.ts';

/** The part of ClipaDirector the journey uses. The real director satisfies it as it is. */
export interface JourneyDirector {
  readonly state: ClipaState;
  /** Fly beside the target and take the pointing pose; without a target, point in place. */
  point(target?: ClipaTarget): Promise<ClipaResult>;
  /** Put the text in the bubble. */
  speak(text: string): Promise<ClipaResult>;
  retreat(): Promise<ClipaResult>;
  setOff(off: boolean): Promise<ClipaResult>;
  /** Resolves when Clipa is docked (or off), not flying and nothing is queued. */
  idle(): Promise<void>;
}

export interface JourneyClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface JourneyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface JourneyOptions {
  director: JourneyDirector;
  events: JourneyEventSource;
  /** Viewport rect of the element with this data-clipa-target value, or null when it is not on the page. */
  resolveTarget(target: string): RectLike | null;
  /** Where the position is kept. Default: localStorage when it works. `null`: nowhere. */
  storage?: JourneyStorage | null;
  storageKey?: string;
  steps?: readonly JourneyStep[];
  /** What the device can capture. Default: looked up from navigator.mediaDevices. */
  capabilities?: CaptureCapabilities;
  /** True while a capture is live. After a reload it is false, which sends capture steps back to the start. */
  isCapturing?(): boolean;
  /** The line went up in the bubble; the shell speaks it (unless off the record). */
  onSay?(line: string, step: JourneyStep): void;
  clock?: JourneyClock;
  /** After typing or talking stops, wait this long before Clipa speaks again. Default 1500. */
  quietSettleMs?: number;
  /** After an agent question, stay out of the way for this long. Default 12000. */
  agentQuietMs?: number;
  /** A stored position older than this is ignored. Default 6 hours. */
  maxAgeMs?: number;
}

export type StepOutcome = 'done' | 'skipped';

export interface JourneySnapshot {
  stepId: JourneyStepId;
  index: number;
  count: number;
  phase: JourneyPhase;
  persona: JourneyPersona;
  mode: JourneyMode;
  /** The step's mode gate is open (the app has reached the step's mode). */
  active: boolean;
  /** The current step's line has been said (or, for an agent-voiced step, the agent has the floor). */
  delivered: boolean;
  /** The last step has been said. */
  done: boolean;
  /** Clipa is quiet right now: typing, talking, the agent speaking or asking, or off the record. */
  quiet: boolean;
  offRecord: boolean;
  capture: CapturePath;
  variant: JourneyVariant | null;
  /** The line currently shown or last said, or null. */
  line: string | null;
  questions: number;
  guardrailQuestions: number;
  outcomes: Readonly<Partial<Record<JourneyStepId, StepOutcome>>>;
}

export interface Journey {
  getSnapshot(): JourneySnapshot;
  subscribe(listener: () => void): () => void;
  /** Feeds one event, as if it came from `events`. */
  dispatch(event: JourneyEvent): void;
  /** Says a step that is already done once more. Moves nothing. Returns false when it cannot (not done, no target, quiet). */
  replay(id: JourneyStepId): boolean;
  /** Forgets the stored position and starts over from the first step. */
  reset(): void;
  destroy(): void;
}

interface SavedState {
  v: 1;
  stepId: JourneyStepId;
  mode: JourneyMode;
  outcomes: Partial<Record<JourneyStepId, StepOutcome>>;
  nudged: JourneyStepId[];
  done: boolean;
  savedAt: number;
}

type PresentKind = 'enter' | 'nudge' | 'replay';
interface Presentation {
  kind: PresentKind;
  index: number;
}

export const JOURNEY_STORAGE_KEY = 'apprentice.journey.v1';
const DEFAULT_QUIET_SETTLE_MS = 1500;
const DEFAULT_AGENT_QUIET_MS = 12_000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_MS = 4000;

function defaultClock(): JourneyClock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
  };
}

function defaultStorage(): JourneyStorage | null {
  try {
    return (globalThis as { localStorage?: JourneyStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function isSavedState(value: unknown): value is SavedState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SavedState>;
  return (
    v.v === 1 &&
    typeof v.stepId === 'string' &&
    isJourneyMode(v.mode) &&
    typeof v.done === 'boolean' &&
    typeof v.savedAt === 'number' &&
    Array.isArray(v.nudged) &&
    typeof v.outcomes === 'object' &&
    v.outcomes !== null
  );
}

export function createJourney(options: JourneyOptions): Journey {
  const steps = options.steps ?? JOURNEY_STEPS;
  if (steps.length === 0) throw new Error('journey: the step table is empty');
  const director = options.director;
  const clock = options.clock ?? defaultClock();
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const storageKey = options.storageKey ?? JOURNEY_STORAGE_KEY;
  const quietSettleMs = options.quietSettleMs ?? DEFAULT_QUIET_SETTLE_MS;
  const agentQuietMs = options.agentQuietMs ?? DEFAULT_AGENT_QUIET_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const caps: CaptureCapabilities = { ...(options.capabilities ?? detectCapabilities()) };
  const isCapturing = options.isCapturing ?? (() => false);
  const last = steps.length - 1;
  const at = (i: number): JourneyStep => {
    const step = steps[i];
    if (!step) throw new Error(`journey: no step at ${i}`);
    return step;
  };

  // ---- progress (persisted) -------------------------------------------------------------------------------------
  let index = 0;
  let mode: JourneyMode = 'learn';
  let outcomes: Partial<Record<JourneyStepId, StepOutcome>> = {};
  const nudged = new Set<JourneyStepId>();
  let done = false;
  /** An explicit wording for the current step: a refused picker, a reload, the mask review. */
  let variant: JourneyVariant | null = null;

  // ---- runtime ----------------------------------------------------------------------------------------------------
  const seen = new Set<string>();
  const delivered = new Set<JourneyStepId>();
  let lastLine: string | null = null;
  let questions = 0;
  let guardrailQuestions = 0;
  let typing = false;
  let talkingPerson = false;
  let talkingAgent = false;
  let offRecord = false;
  let agentBusyUntil = 0;
  let token = 0;
  let inflight: Presentation | null = null;
  let pending: Presentation | null = null;
  let presenting = false;
  let nudgeDue = false;
  let retries = 0;
  let nudgeTimer: unknown = null;
  let settleTimer: unknown = null;
  let destroyed = false;
  const listeners = new Set<() => void>();

  const quiet = (): boolean => typing || talkingPerson || talkingAgent || offRecord || clock.now() < agentBusyUntil;
  const waitingForEdge = (): boolean => typing || talkingPerson || talkingAgent || offRecord;

  // ---- storage ------------------------------------------------------------------------------------------------------

  function save(): void {
    if (!storage) return;
    const state: SavedState = {
      v: 1,
      stepId: at(index).id,
      mode,
      outcomes,
      nudged: [...nudged],
      done,
      savedAt: clock.now(),
    };
    try {
      storage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Storage may be full, blocked or gone (private window): the journey still works for this page load.
    }
  }

  function restore(): void {
    if (!storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const saved: unknown = JSON.parse(raw);
      if (!isSavedState(saved)) return;
      if (saved.done || clock.now() - saved.savedAt > maxAgeMs) {
        storage.removeItem(storageKey);
        return;
      }
      const found = steps.findIndex((step) => step.id === saved.stepId);
      if (found < 0) return;
      index = found;
      mode = saved.mode;
      outcomes = { ...saved.outcomes };
      for (const id of saved.nudged) nudged.add(id);
      if (at(index).needsCapture && !isCapturing()) {
        // A reload ends the capture, so the person has to share again before this step makes sense.
        index = 0;
        nudged.clear();
        if (at(0).variants?.resume) variant = 'resume';
      }
    } catch {
      // A corrupt or unreadable entry is the same as no entry.
    }
  }

  // ---- snapshot -------------------------------------------------------------------------------------------------------

  const isActive = (step: JourneyStep): boolean => !step.mode || modeRank(mode) >= modeRank(step.mode);
  const gateOpen = (step: JourneyStep): boolean =>
    !step.enter.on || step.enter.on.length === 0 || step.enter.on.some((m) => seen.has(m.type));

  function build(): JourneySnapshot {
    const step = at(index);
    // A step the app has not reached yet (summary while still in Teach) leaves the person in the phase before it.
    const shown = !isActive(step) && index > 0 ? at(index - 1) : step;
    return {
      stepId: step.id,
      index,
      count: steps.length,
      phase: shown.phase,
      persona: shown.persona,
      mode,
      active: isActive(step) && gateOpen(step),
      delivered: delivered.has(step.id),
      done,
      quiet: quiet(),
      offRecord,
      capture: capturePath(caps),
      variant: chooseVariant(step, true),
      line: lastLine,
      questions,
      guardrailQuestions,
      outcomes: { ...outcomes },
    };
  }

  let snapshot: JourneySnapshot;
  function commit(): void {
    snapshot = build();
    save();
    for (const listener of [...listeners]) listener();
  }

  // ---- wording ----------------------------------------------------------------------------------------------------------

  /** Which alternative wording applies to the step now, if any. */
  function chooseVariant(step: JourneyStep, explicit: boolean): JourneyVariant | null {
    const path = capturePath(caps);
    const table = step.variants;
    if (!table) return null;
    if (path === 'none' && table.none) return 'none';
    if (explicit && variant) {
      let v: JourneyVariant = variant;
      if (v === 'denied' && path === 'camera') v = 'camera';
      else if (v === 'denied' && caps.camera) v = 'deniedCamera';
      if (table[v]) return v;
    }
    if (path === 'camera' && table.camera) return 'camera';
    return null;
  }

  function textFor(step: JourneyStep, kind: PresentKind): JourneyText {
    const v = chooseVariant(step, kind !== 'replay');
    const alt = v ? step.variants?.[v] : undefined;
    if (alt) return { target: alt.target ?? step.target, line: alt.line, ...(alt.inPlace ? { inPlace: true } : {}) };
    if (kind === 'nudge' && step.nudge) {
      return { target: step.nudge.target ?? step.target, line: step.nudge.line ?? step.line };
    }
    return { target: step.target, line: step.line };
  }

  /** The first of the step's targets that is on the page right now. */
  function resolvable(step: JourneyStep, text: JourneyText): string | null {
    if (text.inPlace) return null;
    const names = [text.target, step.target, step.fallbackTarget];
    for (const name of names) {
      if (name && options.resolveTarget(name)) return name;
    }
    return null;
  }

  // ---- presenting a line ----------------------------------------------------------------------------------------------

  function retreatIfPresenting(): void {
    if (!presenting) return;
    presenting = false;
    if (director.state !== 'dock' && director.state !== 'off') void director.retreat();
  }

  /** Drops a presentation in progress; a step's own line (not a nudge or replay) is kept to say later. */
  function interrupt(): void {
    token += 1;
    if (inflight && inflight.kind !== 'replay') pending = inflight;
    inflight = null;
  }

  function clearSettle(): void {
    if (settleTimer !== null) clock.clearTimeout(settleTimer);
    settleTimer = null;
  }
  function clearNudge(): void {
    if (nudgeTimer !== null) clock.clearTimeout(nudgeTimer);
    nudgeTimer = null;
    nudgeDue = false;
  }

  /** After the quiet ends (and `quietSettleMs` more), say what was held back. */
  function scheduleResume(): void {
    clearSettle();
    if (destroyed || waitingForEdge()) return;
    const wait = Math.max(0, agentBusyUntil - clock.now()) + quietSettleMs;
    settleTimer = clock.setTimeout(resume, wait);
  }

  function resume(): void {
    settleTimer = null;
    if (destroyed) return;
    if (quiet()) {
      scheduleResume();
      return;
    }
    if (pending && pending.index === index) {
      const next = pending;
      pending = null;
      void present(next.kind, next.index);
      return;
    }
    pending = null;
    if (nudgeDue) {
      nudgeDue = false;
      fireNudge(index);
      return;
    }
    reconcile();
  }

  function fail(reason: string, kind: PresentKind, i: number): void {
    // 'input-active' and 'cancelled' mean somebody else had the stage: try again a couple of times, later.
    if ((reason === 'input-active' || reason === 'cancelled') && kind !== 'replay' && retries < MAX_RETRIES) {
      retries += 1;
      pending = { kind, index: i };
      clearSettle();
      settleTimer = clock.setTimeout(resume, RETRY_MS);
    }
  }

  async function present(kind: PresentKind, i: number): Promise<void> {
    const step = at(i);
    const mine = (token += 1);
    const me: Presentation = { kind, index: i };
    pending = null;
    if (quiet()) {
      if (kind !== 'replay') {
        pending = me;
        scheduleResume();
      }
      return;
    }
    inflight = me;
    const live = (): boolean => mine === token && !destroyed;

    // She may still be pointing at the last step's control; otherwise wait until the agent's turn is over.
    if (!(presenting && director.state === 'pointing')) {
      await director.idle();
      if (!live()) return;
      if (quiet()) {
        inflight = null;
        if (kind !== 'replay') pending = me;
        scheduleResume();
        return;
      }
    }

    const text = textFor(step, kind);
    const name = resolvable(step, text);
    let flown = await director.point(name ? journeyClipaTarget(name) : undefined);
    // The control went away between the lookup and the flight: say it in place instead.
    if (live() && name && !flown.ok && flown.reason === 'no-target') flown = await director.point();
    if (!live()) return;
    if (!flown.ok) {
      inflight = null;
      fail(flown.reason, kind, i);
      return;
    }
    presenting = true;
    const said = await director.speak(text.line);
    if (!live()) return;
    inflight = null;
    if (!said.ok) {
      fail(said.reason, kind, i);
      return;
    }
    lastLine = text.line;
    retries = 0;
    options.onSay?.(text.line, step);
    if (kind === 'enter') {
      delivered.add(step.id);
      if (i === last) {
        done = true;
        mark(step.id, 'done');
        clearNudge();
      } else {
        armNudge();
      }
    }
    commit();
  }

  // ---- the gentle re-nudge ----------------------------------------------------------------------------------------------

  function armNudge(): void {
    clearNudge();
    const step = at(index);
    if (!step.nudge || nudged.has(step.id) || done) return;
    if (chooseVariant(step, true) === 'none') return; // nothing the person can do about it
    const armedFor = index;
    nudgeTimer = clock.setTimeout(() => {
      nudgeTimer = null;
      fireNudge(armedFor);
    }, step.nudge.afterMs);
  }

  function fireNudge(i: number): void {
    if (destroyed || done || i !== index) return;
    const step = at(i);
    if (nudged.has(step.id) || !isActive(step) || !gateOpen(step)) return;
    if (quiet()) {
      nudgeDue = true;
      scheduleResume();
      return;
    }
    nudged.add(step.id);
    void present('nudge', i);
    commit();
  }

  // ---- moving along -------------------------------------------------------------------------------------------------------

  function mark(id: JourneyStepId, outcome: StepOutcome): void {
    if (outcomes[id] !== 'done') outcomes[id] = outcome;
  }

  /** Moves past every step the event (or the mode the app is in) ends. Returns true when the position changed. */
  function advance(event: JourneyEvent | null): boolean {
    const from = index;
    while (index < last) {
      const step = at(index);
      const byEvent = event !== null && step.exit.some((m) => matchesEvent(m, event));
      // A step of an earlier mode is over once the app has moved on, whatever the person did in it.
      const passed = step.mode !== undefined && modeRank(mode) > modeRank(step.mode);
      const byMode = passed || step.exit.some((m) => matchesMode(m, mode));
      if (!byEvent && !byMode) break;
      mark(step.id, byEvent ? 'done' : 'skipped');
      index += 1;
    }
    return index !== from;
  }

  /** Forget everything about the step we were on: its line, nudge and retries. */
  function leaveStep(): void {
    token += 1;
    inflight = null;
    pending = null;
    retries = 0;
    variant = null;
    clearNudge();
    clearSettle();
  }

  function restartStep(): void {
    token += 1;
    inflight = null;
    pending = null;
    retries = 0;
    delivered.delete(at(index).id);
    clearNudge();
  }

  /** Says the current step if it is due and has not been said. */
  function reconcile(): void {
    if (destroyed || done) return;
    const step = at(index);
    if (!isActive(step) || !gateOpen(step)) {
      retreatIfPresenting();
      return;
    }
    if (delivered.has(step.id)) return;
    if (inflight?.index === index || pending?.index === index) return;
    if (step.voice === 'agent') {
      // The agent has the floor here (teach-back, the checkpoint warning): Clipa stands aside and does not touch
      // the director, so the agent's own pose and bubble stay as they are.
      delivered.add(step.id);
      presenting = false;
      armNudge();
      return;
    }
    void present('enter', index);
  }

  /** Back to the first step, saying `why` in its wording. Keeps what the person has already done. */
  function rewind(why: JourneyVariant): void {
    leaveStep();
    delivered.clear();
    index = 0;
    if (at(0).variants?.[why]) variant = why;
  }

  function onUnavailable(reason: ShareFailure | undefined): void {
    if (reason === 'unsupported') {
      caps.screen = false;
    }
    const step = at(index);
    const inSharePhase = step.phase === at(0).phase;
    if (inSharePhase) {
      rewind(reason === 'lost' ? 'lost' : 'denied');
    } else if (reason === 'lost' && step.needsCapture) {
      rewind('lost');
    }
  }

  // ---- events ------------------------------------------------------------------------------------------------------------------

  function handle(event: JourneyEvent): void {
    if (destroyed) return;
    seen.add(event.type);
    switch (event.type) {
      case 'typing':
        typing = event.active;
        quietChanged(event.active);
        return;
      case 'talking':
        if (event.by === 'agent') talkingAgent = event.active;
        else talkingPerson = event.active;
        quietChanged(event.active);
        return;
      case 'off_record':
        if (offRecord === event.on) return;
        offRecord = event.on;
        if (event.on) {
          presenting = false;
          void director.setOff(true);
        } else {
          void director.setOff(false);
        }
        quietChanged(event.on);
        return;
      case 'agent_asked':
        questions += 1;
        if (event.guardrail) guardrailQuestions += 1;
        agentBusyUntil = clock.now() + agentQuietMs;
        interrupt();
        presenting = false; // the agent has the stage now
        if (pending) scheduleResume();
        commit();
        return;
      default:
        break;
    }

    if (done) return;
    // The agent takes the stage at these moments, so Clipa no longer owns the pose she is in.
    if (event.type === 'checkpoint_warned' || event.type === 'teachback_started') presenting = false;
    if (event.type === 'session_started' && event.mode) mode = event.mode;
    if (event.type === 'mode_changed') mode = event.mode;

    const moved = advance(event);
    if (moved) leaveStep();
    if (event.type === 'screen_unavailable') onUnavailable(event.reason);
    if (event.type === 'mask_review' && at(index).variants?.maskReview) {
      variant = 'maskReview';
      restartStep();
    }
    commit();
    reconcile();
    // A step that is already said keeps its nudge; a new one arms it when it is said.
  }

  /** Typing, talking or off-record started (loud) or ended. Loud: Clipa goes quiet at once. */
  function quietChanged(loud: boolean): void {
    if (loud) {
      interrupt();
      clearSettle();
      retreatIfPresenting();
    } else {
      scheduleResume();
    }
    commit();
  }

  // ---- go ------------------------------------------------------------------------------------------------------------------------

  restore();
  snapshot = build();
  const unsubscribe = options.events.subscribe(handle);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: handle,
    replay(id) {
      const target = steps.findIndex((step) => step.id === id);
      if (destroyed || target < 0 || !(done || target < index) || quiet() || inflight || pending) return false;
      const step = at(target);
      if (!resolvable(step, textFor(step, 'replay'))) return false;
      void present('replay', target);
      return true;
    },
    reset() {
      if (destroyed) return;
      leaveStep();
      retreatIfPresenting();
      index = 0;
      outcomes = {};
      nudged.clear();
      delivered.clear();
      done = false;
      questions = 0;
      guardrailQuestions = 0;
      lastLine = null;
      try {
        storage?.removeItem(storageKey);
      } catch {
        // Nothing to clear.
      }
      commit();
      reconcile();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      token += 1;
      clearNudge();
      clearSettle();
      unsubscribe();
      listeners.clear();
    },
  };
}

