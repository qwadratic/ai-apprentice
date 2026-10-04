// Wires the real world (browser fetch, timers, ElevenLabs, localStorage, the Clipa motion director) into the controller.
import { createClipaDirector } from '../clipa/src/index.ts';
import type { ClipaTarget } from '../clipa/src/index.ts';
import '../../demo-workspace/workspace.css';
import { createDemoWorkspaceAdapter } from './slots/demo-workspace-adapter.ts';
import type { WorkspaceAdapter } from './slots/workspace-adapter.ts';
import { createAgentApi } from './api.ts';
import type { FetchLike } from './api.ts';
import { AgentBrain } from './brain/agent-brain.ts';
import { POINT_HOLD_MS, createDirectorPresenter } from './clipa/director-presenter.ts';
import { startDrift } from './clipa/drift.ts';
import { InputGuard, watchPageInput } from './clipa/input-guard.ts';
import { createClipaStore } from './clipa/presenter.ts';
import type { ClipaStore } from './clipa/presenter.ts';
import { resolveClipaTarget } from './clipa/targets.ts';
import { API_BASE } from './config.ts';
import { readJoinParams, withoutJoinParams } from './conductor/join.ts';
import type { Target } from './conductor/protocol.ts';
import type { ConductorLine } from './conductor/store.ts';
import type { BrainDecision } from './brain/types.ts';
import { CONDUCTOR_SURFACE, clipaHint, resolveTarget as resolveConductorTarget } from './conductor/targets.ts';
import { ShellController } from './controller.ts';
import type { ControllerTimers, KeyValueStorage } from './controller.ts';
import { SampleObservationSource } from './screen/sample-source.ts';
import { createRuntimeWorkspace } from '../../demo-workspace/index.ts';
import { LiveMount } from './screen/live-mount.ts';
import { bindWorkspaceCheckpoint } from './screen/checkpoint-binding.ts';
import type { BindableWorkspace } from './screen/checkpoint-binding.ts';
import { SAMPLE_CUSTOMERS } from './screen/sample-scenarios.ts';
import type { CreateRuntimeWorkspace } from './screen/runtime-workspace-source.ts';
import { connectElevenLabs } from './voice/elevenlabs.ts';
import type { VoiceConnector } from './voice/types.ts';

export interface ShellRuntime {
  controller: ShellController;
  clipa: ClipaStore;
  /** Stream A's demo workspace behind the seam of slots/workspace-adapter.ts; null until it is wired (the slot shows stand-ins). */
  workspace: WorkspaceAdapter | null;
  /** Stream A's integrated runtime (real bridge, screen panel, workspace) mounted per session; null until A's commit is on main. */
  live: LiveMount | null;
  /**
   * Clipa flies to a conductor target (a UI element marked data-clipa-target, or a region of the screen preview); null: she stays.
   * The conductor's cues call it; a Clipa layer may call it too.
   */
  pointAt(target: Target | null): void;
  /** Clipa's bubble text ('' clears it). Shown only, never spoken: speech goes through the voice agent. */
  say(text: string): void;
  /** Removes the Clipa layer and the page listeners. The controller is disposed separately. */
  dispose(): void;
}

/** The web app's version in the conductor hello. */
export const WEB_FACE_VERSION = 'web-1.1';
/** Clipa stays beside a region of the screen preview this long: it is what the question or warning is about. */
const REGION_HOLD_MS = 9000;

const browserTimers: ControllerTimers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

// localStorage may be blocked or throw (private windows, cleared site data): the controller wraps every call.
const browserStorage: KeyValueStorage = {
  get: (key) => window.localStorage.getItem(key),
  set: (key, value) => { window.localStorage.setItem(key, value); },
};

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The real screen and the demo workspace, mounted per session: stream A's `createRuntimeWorkspace` (PR #33: capture, ScreenBridge,
 * screen panel, demo workspace and its checkpoint adapter as one lifecycle). Teach checkpoints come from its Preview -> Send.
 */
const liveFactory: CreateRuntimeWorkspace = createRuntimeWorkspace;

/**
 * Seam for the browser harness only (end-to-end runs where no microphone or real speech exists): a hook the harness puts on
 * `window.__APPRENTICE_HARNESS__` before the page loads. Nothing sets it in normal use; then the real voice is used.
 */
export interface HarnessHook {
  connectVoice?: VoiceConnector;
  onRuntime?(runtime: ShellRuntime): void;
}

function harnessHook(): HarnessHook | null {
  try {
    const hook = (window as unknown as { __APPRENTICE_HARNESS__?: HarnessHook }).__APPRENTICE_HARNESS__;
    return hook !== undefined && hook !== null && typeof hook === 'object' ? hook : null;
  } catch {
    return null;
  }
}

export function createRuntime(): ShellRuntime {
  const harness = harnessHook();
  const store = createClipaStore();
  // The director logs refused or illegal commands: they go to the debug log once the controller exists.
  let note: (type: string, text: string) => void = () => {};
  const guard = new InputGuard(() => performance.now());
  const stopWatching = watchPageInput(guard, document);
  // The policy's typing channel: page key presses (the workspace's own heartbeats stop whenever the screen is not `capturing`).
  // The conductor hears it too: `activity typing`, then `idle` after a quiet moment (its pause signal).
  let lastInputAt: number | null = null;
  let onTyping: () => void = () => {};
  const stopInputClock = watchPageInput({ noteInput: () => { lastInputAt = Date.now(); onTyping(); } }, document);
  // Conductor targets the director flies to: the hint names the target, this map holds it (a region's box is read from the
  // live preview when she flies, so it follows the preview). UI names the conductor resolver does not find fall back to the
  // rail's resolver (data-clipa-target names and its fallbacks).
  const pointed = new Map<string, Target>();
  const director = createClipaDirector({
    root: document.body,
    dock: 'bottom-right',
    resolveTarget: (target) => {
      if (target.surface === CONDUCTOR_SURFACE) {
        const t = target.hint === undefined ? undefined : pointed.get(target.hint);
        if (t === undefined) return null;
        return resolveConductorTarget(document, t) ?? (t.kind === 'ui' ? resolveClipaTarget(document, { surface: 'ui', hint: t.name }) : null);
      }
      return resolveClipaTarget(document, target);
    },
    isInputActive: () => guard.isActive(),
    onLog: (entry) => note('CLIPA', `${entry.kind}: ${entry.message}`),
  });
  const presenter = createDirectorPresenter({ store, director, guard });
  const toClipaTarget = (target: Target): ClipaTarget => {
    const hint = clipaHint(target);
    if (pointed.size > 50) pointed.clear();
    pointed.set(hint, target);
    return { surface: CONDUCTOR_SURFACE, hint };
  };
  /** Beside a conductor target in the pointing pose (a region a little longer: it is what a question is about). */
  const pointAt = (target: Target | null): void => {
    if (target === null) return;
    presenter.pointAt(toClipaTarget(target), target.kind === 'region' ? REGION_HOLD_MS : POINT_HOLD_MS);
  };
  /** A conductor line: she flies beside the target (or stands up on the rail) and shows it in her bubble while it is said. */
  const say = (text: string, target?: Target | null): void => {
    const line = text.trim();
    if (line === '') { presenter.say(''); return; }
    presenter.speakAt(line, target ? toClipaTarget(target) : undefined);
  };
  /**
   * One motion per cue (controller ConductorOptions.present): a line with its target, or only a target, or only a line. A
   * warning flies to its target in the warning pose (the director's WARN sequence; it preempts whatever she is doing).
   */
  const present = (text: string | null, target: Target | null | undefined, kind?: ConductorLine['kind']): void => {
    const line = text?.trim() ?? '';
    if (kind === 'warn' && line !== '') {
      const warn: BrainDecision = {
        decision: 'WARN', topic: 'guardrail', kind: 'guardrail', whyNow: 'the conductor warned before a pending action', evidenceIds: [],
        utterance: { text: line }, expectsAnswer: false, clipa: { state: 'warning', ...(target ? { target: toClipaTarget(target) } : {}) },
      };
      presenter.say(line);
      presenter.play?.(warn);
      return;
    }
    if (line !== '') { say(line, target); return; }
    if (text === '') presenter.say('');
    if (target) pointAt(target);
  };
  // Clipa near the cursor while she rests at home (clipa/drift.ts); anything that moves her takes over.
  const actor = (): HTMLElement | null => director.element.parentElement;
  const drift = startDrift({ win: window, actor, resting: () => director.state === 'dock' });
  const stopDriftWake = director.subscribe((event) => { if (event.type === 'state') drift.wake(); });
  /**
   * The conductor's `attention` cue: a quick glow, three pulses (one soft glow with reduced motion). Where she goes comes as its
   * own motion (the face points at a new target), so here she only flashes, and the drift holds still meanwhile.
   */
  const flash = (): void => {
    const el = actor();
    if (el === null || typeof el.animate !== 'function') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const glow = 'drop-shadow(0 0 6px rgba(94, 234, 212, 0.95)) drop-shadow(0 0 16px rgba(44, 196, 184, 0.75))';
    const ms = reduced ? 900 : 1200;
    drift.hold(ms);
    el.animate([{ filter: 'none' }, { filter: glow, offset: 0.5 }, { filter: 'none' }], { duration: reduced ? ms : ms / 3, iterations: reduced ? 1 : 3, easing: 'ease-in-out' });
    if (!reduced) director.element.animate([{ scale: '1' }, { scale: '1.08', offset: 0.5 }, { scale: '1' }], { duration: ms / 3, iterations: 3, easing: 'ease-in-out' });
  };
  // `?conductor=off` keeps the in-browser brain in the lead (the fallback); otherwise the page is a face of the conductor.
  const query = new URLSearchParams(window.location.search);
  const conductorOn = query.get('conductor') !== 'off';

  // An arrow function: an unbound window.fetch would throw "Illegal invocation".
  const fetchFn: FetchLike = (input, init) => fetch(input, init);
  const now = (): number => Date.now();
  const api = createAgentApi({ base: API_BASE, fetch: fetchFn, now, newId });
  const controller = new ShellController({
    api,
    fetch: fetchFn,
    connectVoice: harness?.connectVoice ?? connectElevenLabs,
    // The real policy, Work Map and tutor of packages/agent (TASK-3.29); model calls go through the session's LLM route.
    createBrain: (log) => new AgentBrain({ log, customers: SAMPLE_CUSTOMERS }),
    createSampleSource: (scenario) => new SampleObservationSource(now, browserTimers, scenario),
    presenter,
    now,
    perfNow: () => performance.now(),
    timers: browserTimers,
    isHidden: () => document.hidden,
    storage: browserStorage,
    lastInputAt: () => lastInputAt,
    ...(conductorOn ? {
      conductor: {
        base: API_BASE, version: WEB_FACE_VERSION, present,
        // The rail marks the guide's stage as next and shows its line under the rail.
        guide: (step) => store.setGuide?.(step),
        attention: () => flash(),
      },
    } : {}),
  });
  note = (type, text) => controller.note(type, text);
  onTyping = () => controller.noteTyping();
  // A's createRuntimeWorkspace mounts the demo workspace itself (providesWorkspace).
  const live = new LiveMount({
    factory: liveFactory, controller, apiBase: API_BASE, providesWorkspace: true,
    // Preview & check is answered by the tutor whenever Teach runs, whatever state A's capture status is in.
    bind: (mount) => bindWorkspaceCheckpoint({ workspace: mount.workspace as BindableWorkspace, bridge: mount.bridge, host: controller, now }),
  });
  // The real screen is the default. The sample (invented data, labelled synthetic) is an opt-in switch: it never runs unasked, so
  // a Work Map is not mixed from invented and real observations.
  const runtime: ShellRuntime = {
    controller,
    clipa: store,
    // Stream A's demo workspace; its checkpoint port (A's adapter over the real bridge, PR #21) plugs in here when it lands.
    workspace: createDemoWorkspaceAdapter(),
    live,
    pointAt,
    say: (text) => say(text),
    dispose() {
      live?.dispose();
      stopWatching();
      stopInputClock();
      stopDriftWake();
      drift.dispose();
      presenter.dispose();
    },
  };
  harness?.onRuntime?.(runtime);
  // The macOS hand-over (`?join=CODE&page=review`): the code is single-use, so it leaves the address bar at once.
  const join = readJoinParams(window.location.search);
  if (join.join !== null || join.page !== null) {
    try { window.history.replaceState(window.history.state, '', withoutJoinParams(window.location.href)); } catch { /* the address stays */ }
  }
  if (conductorOn) void controller.bootConductor({ join: join.join, page: join.page });
  else if (join.page !== null) controller.setMode(join.page);
  return runtime;
}
