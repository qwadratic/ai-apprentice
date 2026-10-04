// The ClipaPresenter the product uses: it drives the motion director (apps/web/features/agent/clipa) from the controller.
//   - A spoken decision goes to director.apply(decision): ASK_NOW and PREDICT fly beside the element they are about, speak and
//     listen; WARN flies to Send in the warning pose. The director holds every flight while the person types (input guard) and
//     gives up after a few seconds, and it follows prefers-reduced-motion by itself.
//   - The derived shell state (voice listening, error, off the record, ...) is mapped to a few commands only when they mean
//     something to the director, so the derived state never cancels a sequence that apply() is playing.
//   - The store keeps the text of the current question for the line under the journey rail (an accessible copy of the bubble).
//   - pointAt(target) sends her beside any element (a UI name such as the board's selected item, or a workspace target) in the
//     pointing pose, and back home after `holdMs` unless something else moved her meanwhile. The page asks for it with a
//     `clipa:point` event on the document (requestClipaPoint), so code that has no handle on the presenter can use it too.
import { estimateSpeechMs } from '../../clipa/src/index.ts';
import type { ClipaDecision, ClipaResult, ClipaState as DirectorState, ClipaTarget } from '../../clipa/src/index.ts';
import type { BrainDecision } from '../brain/types.ts';
import type { InputGuard } from './input-guard.ts';
import type { ClipaPresenter, ClipaState, ClipaStore, TargetRect } from './presenter.ts';

/** The part of the director the presenter uses (a fake in the tests). */
export interface DirectorLike {
  readonly state: DirectorState;
  apply(decision: ClipaDecision, options?: { durationMs?: number }): Promise<ClipaResult>;
  setOff(off: boolean): Promise<ClipaResult>;
  listen(level?: number): Promise<ClipaResult>;
  ack(): Promise<ClipaResult>;
  retreat(): Promise<ClipaResult>;
  warn(target?: ClipaTarget): Promise<ClipaResult>;
  point(target?: ClipaTarget): Promise<ClipaResult>;
  destroy(): void;
}

/** The longest a spoken line keeps Clipa's mouth moving if the voice never reports that it has finished. */
const SPEECH_PADDING_MS = 4000;

/** The shell's Clipa cue as the director's state. */
export function directorState(cue: NonNullable<NonNullable<BrainDecision['clipa']>['state']>): DirectorState {
  switch (cue) {
    case 'idle': return 'dock';
    case 'happy': return 'ack';
    default: return cue;
  }
}

/** A BrainDecision as the director reads it. Pure. */
export function toClipaDecision(d: BrainDecision): ClipaDecision {
  const out: ClipaDecision = { decision: d.decision };
  if (d.utterance) {
    out.utterance = { text: d.utterance.text, ...(d.utterance.maxWords !== undefined ? { maxWords: d.utterance.maxWords } : {}) };
  }
  if (d.expectsAnswer !== undefined) out.expectsAnswer = d.expectsAnswer;
  if (d.clipa) {
    const clipa: NonNullable<ClipaDecision['clipa']> = {};
    if (d.clipa.state !== undefined) clipa.state = directorState(d.clipa.state);
    if (d.clipa.target) clipa.target = { surface: d.clipa.target.surface, ...(d.clipa.target.hint !== undefined ? { hint: d.clipa.target.hint } : {}) };
    out.clipa = clipa;
  }
  return out;
}

export type DirectorCommand = 'off' | 'on' | 'listen' | 'warn' | 'point' | 'ack' | 'retreat';

/** The element the replay of a screen moment opens in (ReplaySlot). */
export const REPLAY_TARGET: ClipaTarget = { surface: 'replay' };

/**
 * What the derived shell state asks of the director, given the director's own state and whether a sequence is playing.
 * `previous` is the shell state before. Pure, so the mapping is unit-tested without a DOM.
 */
export function commandsFor(next: ClipaState, previous: ClipaState | null, director: DirectorState, playing: boolean): DirectorCommand[] {
  const out: DirectorCommand[] = [];
  if (next === 'off') return ['off'];
  if (previous === 'off') out.push('on');
  switch (next) {
    case 'listening':
      // The agent finished speaking: the mouth stops, the rings start. A docked Clipa stays docked.
      if (director === 'speaking' || director === 'thinking') out.push('listen');
      break;
    case 'warning':
      // An error or a Teach warning that no decision is already playing (a WARN decision flies to Send by itself).
      if (!playing && director !== 'warning' && director !== 'pointing') out.push('warn');
      break;
    case 'pointing':
      // The replay of the expert's moment is open: she points at it.
      if (!playing && director !== 'pointing') out.push('point');
      break;
    case 'happy':
      if (!playing && (director === 'speaking' || director === 'listening' || director === 'thinking')) out.push('ack');
      break;
    case 'idle':
      if (!playing && (director === 'listening' || director === 'ack' || director === 'speaking')) out.push('retreat');
      break;
    default:
      break;
  }
  return out;
}

/** The document event that asks Clipa to point: detail {target, holdMs?}. */
export const CLIPA_POINT_EVENT = 'clipa:point';
/** How long she stays beside an element she was asked to point at, by default. */
export const POINT_HOLD_MS = 4000;

export interface ClipaPointRequest {
  target: ClipaTarget;
  holdMs?: number;
}

/** Asks the page's Clipa to point at a target (handled by the presenter that listens on this document). */
export function requestClipaPoint(target: ClipaTarget, holdMs: number = POINT_HOLD_MS, events: EventTarget | null = typeof document === 'undefined' ? null : document): boolean {
  if (events === null || typeof CustomEvent === 'undefined') return false;
  const detail: ClipaPointRequest = { target, holdMs };
  return events.dispatchEvent(new CustomEvent(CLIPA_POINT_EVENT, { detail }));
}

function pointRequest(detail: unknown): ClipaPointRequest | null {
  if (detail === null || typeof detail !== 'object') return null;
  const d = detail as { target?: unknown; holdMs?: unknown };
  const t = d.target as { surface?: unknown; hint?: unknown } | null | undefined;
  if (t === null || typeof t !== 'object' || typeof t.surface !== 'string' || t.surface === '') return null;
  const target: ClipaTarget = { surface: t.surface, ...(typeof t.hint === 'string' && t.hint !== '' ? { hint: t.hint } : {}) };
  return { target, ...(typeof d.holdMs === 'number' && d.holdMs >= 0 ? { holdMs: d.holdMs } : {}) };
}

export interface DirectorPresenter extends ClipaPresenter {
  /** The sequence that is playing, or null. Resolves when it has run (not when the person has answered). */
  readonly playing: Promise<unknown> | null;
  /** Beside the target in the pointing pose; home again after holdMs (0: she stays until something else moves her). */
  pointAt(target: ClipaTarget, holdMs?: number): void;
  dispose(): void;
}

export interface DirectorPresenterOptions {
  store: ClipaStore;
  director: DirectorLike;
  guard: InputGuard;
  /** Where `clipa:point` requests arrive. Default: the document, when there is one. null: none. */
  events?: EventTarget | null;
}

export function createDirectorPresenter(options: DirectorPresenterOptions): DirectorPresenter {
  const { store, director, guard } = options;
  let playing: Promise<unknown> | null = null;
  let previous: ClipaState | null = null;
  // Every command that moves her bumps the token, so a pending "go home after pointing" never undoes a later move.
  let moveToken = 0;
  let homeTimer: ReturnType<typeof setTimeout> | null = null;
  const clearHome = (): void => {
    if (homeTimer !== null) clearTimeout(homeTimer);
    homeTimer = null;
  };
  const pointAt = (target: ClipaTarget, holdMs: number = POINT_HOLD_MS): void => {
    clearHome();
    const token = ++moveToken;
    void director.point(target).then((result) => {
      if (!result.ok || holdMs <= 0 || token !== moveToken) return;
      homeTimer = setTimeout(() => {
        homeTimer = null;
        if (token === moveToken && director.state === 'pointing') void director.retreat();
      }, holdMs);
    });
  };
  const events = options.events === undefined ? (typeof document === 'undefined' ? null : document) : options.events;
  const onPoint = (event: Event): void => {
    const request = pointRequest((event as CustomEvent<unknown>).detail);
    if (request !== null) pointAt(request.target, request.holdMs);
  };
  events?.addEventListener(CLIPA_POINT_EVENT, onPoint);

  const run = (command: DirectorCommand): void => {
    switch (command) {
      case 'off': void director.setOff(true); break;
      case 'on': void director.setOff(false); break;
      case 'listen': void director.listen(); break;
      case 'warn': void director.warn(); break;
      case 'point': void director.point(REPLAY_TARGET); break;
      case 'ack': void director.ack(); break;
      case 'retreat': void director.retreat(); break;
    }
  };

  return {
    get playing() { return playing; },
    setState(state) {
      store.setState(state);
      const commands = commandsFor(state, previous, director.state, playing !== null);
    if (commands.length > 0) moveToken += 1;
    for (const command of commands) run(command);
      previous = state;
    },
    say(text) { store.say(text); },
    setTarget(rect: TargetRect | null) { store.setTarget(rect); },
    play(decision) {
      const text = decision.utterance?.text ?? '';
      moveToken += 1;
      clearHome();
      const job = director
        .apply(toClipaDecision(decision), { durationMs: estimateSpeechMs(text) + SPEECH_PADDING_MS })
        .finally(() => { if (playing === job) playing = null; });
      playing = job;
    },
    ack() { void director.ack(); },
    noteInput(typing) { guard.setTyping(typing); },
    pointAt,
    dispose() {
      clearHome();
      events?.removeEventListener(CLIPA_POINT_EVENT, onPoint);
      director.destroy();
    },
  };
}
