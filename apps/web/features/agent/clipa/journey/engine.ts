/*
 * The journey engine: a small state machine over app events that walks the person through the demo and drives
 * the Clipa director (fly to the step's target, say the line in the bubble).
 *
 *   const journey = createJourney({ director, events: bus, resolveTarget: createDomTargetResolver(document) });
 *   bus.emit({ type: 'app_ready', mode: 'learn' });
 *
 * Rules:
 *   - The journey moves forward only on events. Timers are used for exactly two things: the one gentle re-nudge
 *     per step, and retrying a line that was held back while somebody typed or talked.
 *   - While the person types or talks, the agent speaks, or the session is off the record, Clipa is quiet at once:
 *     a flight in progress is dropped, she goes home, and the line waits until it is quiet again.
 *   - When the agent asks a live question Clipa leaves the stage to it; the journey speaks again only after the
 *     director is idle. It never waits on idle() while she is still pointing (that never resolves): it either
 *     re-points (she is ours) or lets the agent's pose be.
 *   - Whenever the engine lets go of her while she still points at one of its controls, she goes home.
 *   - Voice is the shell's job: `onSay(line)` fires when the line goes up in the bubble.
 *   - The current step is stored in sessionStorage (try/catch around every access), so a reload of the same tab resumes
 *     at the Start of the session the person was in (a reload ends the session). A new tab, a finished journey, a
 *     stale entry or a new Learn session starts at step 1.
 */
import type { ClipaResult, ClipaState, ClipaTarget, RectLike } from '../src/types.ts';
import { canShareScreen, canUseCamera, capturePath } from './capabilities.ts';
import type { CaptureCapabilities, CapturePath } from './capabilities.ts';
import { matchesEvent } from './events.ts';
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
  /** Resolves when Clipa is docked (or off), not flying and nothing is queued. It does not resolve while she points. */
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
  /** Where the position is kept. Default: sessionStorage when it works. `null`: nowhere. */
  storage?: JourneyStorage | null;
  storageKey?: string;
  steps?: readonly JourneyStep[];
  /**
   * The shell has a camera source for the capture (stream A's). Default false: until then a device that cannot share a
   * screen is told so plainly instead of being offered a camera nobody reads. Ignored when `capabilities` is given.
   */
  camera?: boolean;
  /** What the device can capture. Default: screen from navigator.mediaDevices, camera only when `camera` is true. */
  capabilities?: CaptureCapabilities;
  /** The shell also captures the screen in Teach: adds the share-teach step. Default false. */
  captureInTeach?: boolean;
  /**
   * True while the observation source is the synthetic sample one, so Clipa does not claim to see the screen. Default:
   * synthetic when the person never shared a window in Learn.
   */
  isSynthetic?(): boolean;
  /** The line went up in the bubble; the shell speaks it (unless off the record). */
  onSay?(line: string, step: JourneyStep): void;
  clock?: JourneyClock;
  /** After typing or talking stops, wait this long before Clipa speaks again. Default 1500. */
  quietSettleMs?: number;
  /** After an agent question, stay out of the way for this long. Default 12000. */
  agentQuietMs?: number;
  /** A stored position older than this is ignored. Default 30 minutes. */
  maxAgeMs?: number;
  /** A fresh id for a run (a Learn session start). Default: random. */
  newRunId?(): string;
}

export type StepOutcome = 'done' | 'skipped';

export interface JourneySnapshot {
  stepId: JourneyStepId;
  index: number;
  count: number;
  /** The ids of the steps of this journey, in order (the table without the optional steps that are off). */
  stepIds: readonly JourneyStepId[];
  phase: JourneyPhase;
  persona: JourneyPersona;
  /** The selected tab. */
  tab: JourneyMode;
  /** The mode whose session is live, or null. */
  session: JourneyMode | null;
  runId: string;
  /** The page is ready (the first step is announced only after that). */
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
  /** Forgets the stored position and starts a new run from the first step. */
  reset(): void;
  destroy(): void;
}

interface SavedState {
  v: 2;
  runId: string;
  stepId: JourneyStepId;
  outcomes: Partial<Record<JourneyStepId, StepOutcome>>;
  nudged: JourneyStepId[];
  savedAt: number;
}

type PresentKind = 'enter' | 'nudge' | 'replay';
interface Presentation {
  kind: PresentKind;
  index: number;
}

/** What to do with Clipa when the engine lets go: leave her, send her home, or only if she is at one of our controls. */
type Release = boolean | 'if-pointing';

export const JOURNEY_STORAGE_KEY = 'apprentice.journey.v2';
const DEFAULT_QUIET_SETTLE_MS = 1500;
const DEFAULT_AGENT_QUIET_MS = 12_000;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_MS = 4000;

function defaultClock(): JourneyClock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
  };
}

/** sessionStorage, not localStorage: a reload of this tab resumes, a new tab (the pitch after a rehearsal) starts fresh. */
function defaultStorage(): JourneyStorage | null {
  try {
    return (globalThis as { sessionStorage?: JourneyStorage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function defaultRunId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSavedState(value: unknown): value is SavedState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SavedState>;
  return (
    v.v === 2 &&
    typeof v.runId === 'string' &&
    typeof v.stepId === 'string' &&
    typeof v.savedAt === 'number' &&
    Array.isArray(v.nudged) &&
    typeof v.outcomes === 'object' &&
    v.outcomes !== null
  );
}

export function createJourney(options: JourneyOptions): Journey {
  const steps = (options.steps ?? JOURNEY_STEPS).filter((step) => !step.optional || options[step.optional] === true);
  if (steps.length === 0) throw new Error('journey: the step table is empty');
  const director = options.director;
  const clock = options.clock ?? defaultClock();
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const storageKey = options.storageKey ?? JOURNEY_STORAGE_KEY;
  const quietSettleMs = options.quietSettleMs ?? DEFAULT_QUIET_SETTLE_MS;
  const agentQuietMs = options.agentQuietMs ?? DEFAULT_AGENT_QUIET_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const newRunId = options.newRunId ?? defaultRunId;
  const caps: CaptureCapabilities = options.capabilities
    ? { ...options.capabilities }
    : { screen: canShareScreen(), camera: options.camera === true && canUseCamera() };
  const last = steps.length - 1;
  const stepIds: readonly JourneyStepId[] = steps.map((step) => step.id);
  const at = (i: number): JourneyStep => {
    const step = steps[i];
    if (!step) throw new Error(`journey: no step at ${i}`);
    return step;
  };
  const indexOfId = (id: JourneyStepId | undefined): number => (id === undefined ? -1 : steps.findIndex((s) => s.id === id));
  /** The first step of the Learn phase: a Learn session starting at or after it begins a new run. */
  const learnStart = steps.findIndex((s) => s.phase === 'learn');

  // ---- progress (persisted) -------------------------------------------------------------------------------------
  let index = 0;
  let runId = newRunId();
  let outcomes: Partial<Record<JourneyStepId, StepOutcome>> = {};
  const nudged = new Set<JourneyStepId>();
  let done = false;
  /** An explicit wording for the current step: a refused picker, a reload, the mask review. */
  let variant: JourneyVariant | null = null;

  // ---- runtime ----------------------------------------------------------------------------------------------------
  let tab: JourneyMode = 'learn';
  let liveMode: JourneyMode | null = null;
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
  /** Clipa is out at one of our targets (we put her there and nobody has taken over). */
  let presenting = false;
  /** We have a director call in progress (the flight, the bubble). */
  let directing = false;
  let nudgeDue = false;
  let retries = 0;
  let nudgeTimer: unknown = null;
  let settleTimer: unknown = null;
  let destroyed = false;
  const listeners = new Set<() => void>();

  const quiet = (): boolean => typing || talkingPerson || talkingAgent || offRecord || clock.now() < agentBusyUntil;
  const waitingForEdge = (): boolean => typing || talkingPerson || talkingAgent || offRecord;
  const synthetic = (): boolean => (options.isSynthetic ? options.isSynthetic() : outcomes['share'] === 'skipped');

  // ---- storage ------------------------------------------------------------------------------------------------------

  function save(): void {
    if (!storage) return;
    try {
      if (done) {
        storage.removeItem(storageKey); // a finished journey leaves nothing behind
        return;
      }
      const state: SavedState = {
        v: 2,
        runId,
        stepId: at(index).id,
        outcomes,
        nudged: [...nudged],
        savedAt: clock.now(),
      };
      storage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Storage may be full, blocked or gone (private window): the journey still works for this page load.
    }
  }

  function forget(): void {
    try {
      storage?.removeItem(storageKey);
    } catch {
      // Nothing to clear.
    }
  }

  function restore(): void {
    if (!storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const saved: unknown = JSON.parse(raw);
      if (!isSavedState(saved)) return;
      if (clock.now() - saved.savedAt > maxAgeMs) {
        storage.removeItem(storageKey);
        return;
      }
      const found = indexOfId(saved.stepId);
      if (found < 0) return;
      // A reload ends the session, so the journey goes back to where that session is started.
      const resumeAt = indexOfId(at(found).resume);
      index = resumeAt >= 0 ? resumeAt : found;
      runId = saved.runId;
      outcomes = { ...saved.outcomes };
      for (const id of saved.nudged) nudged.add(id);
      for (let i = index; i <= last; i += 1) {
        delete outcomes[at(i).id];
        nudged.delete(at(i).id);
      }
      if (at(index).variants?.resume) variant = 'resume';
    } catch {
      // A corrupt or unreadable entry is the same as no entry.
    }
  }

  // ---- snapshot -------------------------------------------------------------------------------------------------------

  /** Nothing is said before the page is ready (its controls are mounted); a step may add a gate of its own. */
  const gateOpen = (step: JourneyStep): boolean =>
    seen.has('app_ready') && (!step.enter.on || step.enter.on.length === 0 || step.enter.on.some((m) => seen.has(m.type)));

  function build(): JourneySnapshot {
    const step = at(index);
    return {
      stepId: step.id,
      index,
      count: steps.length,
      stepIds,
      phase: step.phase,
      persona: step.persona,
      tab,
      session: liveMode,
      runId,
      active: gateOpen(step),
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
    if (step.tab && step.tab !== tab && table.wrongTab) return 'wrongTab';
    if (table.synthetic && synthetic()) return 'synthetic';
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

  // ---- giving the stage back --------------------------------------------------------------------------------------------

  /**
   * The engine lets go of Clipa. `true`: send her home whatever she is doing (the person typed or spoke, or the session
   * went off the record). 'if-pointing': send her home only if she is still at one of our controls (the agent speaks, asks
   * or starts the teach-back, and she must not stay behind at a control, nor make its approach queue behind her).
   * `false`: only stop owning her (the agent is about to work her pose and bubble).
   */
  function standDown(release: Release): void {
    const ours = presenting || directing;
    presenting = false;
    directing = false;
    if (!ours || release === false) return;
    const state = director.state;
    if (state === 'dock' || state === 'off') return;
    if (release === 'if-pointing' && state !== 'pointing') return;
    void director.retreat();
  }

  /** A stale director call finished after the engine moved on: if nobody else took her, she goes home. */
  function strandedCheck(): void {
    if (inflight) return; // a newer line is on its way and will move her itself
    presenting = false;
    directing = false;
    const state = director.state;
    if (state !== 'dock' && state !== 'off') void director.retreat();
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

  /** Somebody else has the stage: try again a couple of times, later. */
  function retryLater(kind: PresentKind, i: number): void {
    if (kind === 'replay' || retries >= MAX_RETRIES) return;
    retries += 1;
    pending = { kind, index: i };
    clearSettle();
    settleTimer = clock.setTimeout(resume, RETRY_MS);
  }

  // ---- presenting a line ----------------------------------------------------------------------------------------------

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

    if (director.state === 'pointing') {
      // idle() never resolves while she points, so never wait for it. Pointing at one of our controls: just move her
      // to the new one. Pointing for somebody else (the agent's replay of a moment): leave her, try again later.
      if (!presenting) {
        inflight = null;
        retryLater(kind, i);
        return;
      }
    } else {
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
    directing = true;
    let flown = await director.point(name ? journeyClipaTarget(name) : undefined);
    // The control went away between the lookup and the flight: say it in place instead.
    if (live() && name && !flown.ok && flown.reason === 'no-target') flown = await director.point();
    if (!live()) {
      if (flown.ok) strandedCheck();
      return;
    }
    if (!flown.ok) {
      inflight = null;
      directing = false;
      if (flown.reason === 'input-active' || flown.reason === 'cancelled') retryLater(kind, i);
      return;
    }
    presenting = true;
    const said = await director.speak(text.line);
    if (!live()) {
      if (said.ok) strandedCheck();
      return;
    }
    inflight = null;
    directing = false;
    if (!said.ok) {
      if (said.reason === 'input-active' || said.reason === 'cancelled') retryLater(kind, i);
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
    if (nudged.has(step.id) || !gateOpen(step)) return;
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

  /** Moves past every step the event ends (done) or makes pointless (skipped). Returns true when the position changed. */
  function advance(event: JourneyEvent): boolean {
    const from = index;
    while (index < last) {
      const step = at(index);
      const byExit = step.exit.some((m) => matchesEvent(m, event));
      const bySkip = !byExit && (step.skip?.some((m) => matchesEvent(m, event)) ?? false);
      if (!byExit && !bySkip) break;
      mark(step.id, byExit ? 'done' : 'skipped');
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
    if (!gateOpen(step)) return;
    if (delivered.has(step.id)) return;
    if (inflight?.index === index || pending?.index === index) return;
    if (step.voice === 'agent') {
      // The agent has the floor here (teach-back, the checkpoint warning): Clipa does not speak. If she is still
      // pointing at our last control she goes home, so she does not stand there while the agent talks.
      delivered.add(step.id);
      standDown('if-pointing');
      armNudge();
      return;
    }
    void present('enter', index);
  }

  /** A new run: a Learn session starts after the journey was already past it (a rehearsal, a second demo). */
  function startNewRun(): void {
    leaveStep();
    standDown(true);
    forget();
    runId = newRunId();
    index = 0;
    outcomes = {};
    nudged.clear();
    delivered.clear();
    done = false;
    questions = 0;
    guardrailQuestions = 0;
    lastLine = null;
  }

  function onUnavailable(reason: ShareFailure | undefined): void {
    if (reason === 'unsupported') caps.screen = false;
    if (!at(index).capture) return; // only the share step is about the picker
    variant = reason === 'lost' ? 'lost' : reason === 'unsupported' ? null : 'denied';
    restartStep();
  }

  // ---- events ------------------------------------------------------------------------------------------------------------------

  function handle(event: JourneyEvent): void {
    if (destroyed) return;
    seen.add(event.type);
    const before = variantKey();
    switch (event.type) {
      case 'typing':
        if (typing === event.active) return;
        typing = event.active;
        quietChanged(event.active, true);
        return;
      case 'talking': {
        const by = event.by === 'agent' ? 'agent' : 'person';
        if ((by === 'agent' ? talkingAgent : talkingPerson) === event.active) return;
        if (by === 'agent') talkingAgent = event.active;
        else talkingPerson = event.active;
        // The person talking sends Clipa home. The agent talking only moves her if she still stands at our control.
        quietChanged(event.active, by === 'person' ? true : 'if-pointing');
        return;
      }
      case 'off_record':
        if (offRecord === event.on) return;
        offRecord = event.on;
        void director.setOff(event.on);
        quietChanged(event.on, true);
        return;
      case 'agent_asked':
        questions += 1;
        if (event.guardrail) guardrailQuestions += 1;
        agentBusyUntil = clock.now() + agentQuietMs;
        interrupt();
        standDown('if-pointing'); // the agent has the stage now; its approach must not queue behind her
        break;
      case 'teachback_started':
        standDown('if-pointing');
        break;
      case 'checkpoint_warned':
        standDown(false); // the WARN decision preempts her pose and flies her to Send itself
        break;
      case 'sent':
        // The new hire fixed the draft and Send went through: the warning (or the replay of the expert's moment) is moot.
        if (at(index).phase === 'teach' && (director.state === 'warning' || director.state === 'pointing')) {
          presenting = false;
          directing = false;
          void director.retreat();
        }
        break;
      case 'app_ready':
        if (event.mode) tab = event.mode;
        break;
      case 'mode_changed':
        tab = event.mode;
        break;
      case 'session_live':
        liveMode = event.mode;
        if (event.mode === 'learn' && learnStart >= 0 && (done || index >= learnStart)) startNewRun();
        break;
      case 'session_ended':
        liveMode = null;
        // Off the record ends the session too, but the person did not finish it: they start it again.
        if (offRecord || event.reason === 'off_record') {
          commit();
          return;
        }
        break;
      case 'share_requested':
        if (variant === 'denied' || variant === 'lost') variant = null;
        break;
      default:
        break;
    }

    if (done) {
      commit();
      return;
    }
    const moved = advance(event);
    if (moved) leaveStep();
    if (event.type === 'screen_unavailable') onUnavailable(event.reason);
    if (event.type === 'mask_review' && at(index).capture && at(index).variants?.maskReview) {
      variant = 'maskReview';
      restartStep();
    } else if (!moved && delivered.has(at(index).id) && variantKey() !== before) {
      restartStep(); // the tab changed, or the device turned out unable to share: say the step in its new wording
    }
    commit();
    reconcile();
  }

  function variantKey(): string {
    const step = at(index);
    return `${step.id}:${chooseVariant(step, true) ?? ''}`;
  }

  /** Typing, talking or off-record started (loud) or ended. Loud: Clipa goes quiet at once. */
  function quietChanged(loud: boolean, release: Release): void {
    if (loud) {
      interrupt();
      clearSettle();
      standDown(release);
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
      const target = indexOfId(id);
      if (destroyed || target < 0 || !(done || target < index) || quiet() || inflight || pending) return false;
      const step = at(target);
      if (!resolvable(step, textFor(step, 'replay'))) return false;
      void present('replay', target);
      return true;
    },
    reset() {
      if (destroyed) return;
      startNewRun();
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
