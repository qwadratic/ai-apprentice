// Wires the real world (browser fetch, timers, ElevenLabs, localStorage, the Clipa motion director) into the controller.
import { createClipaDirector } from '../clipa/src/index.ts';
import '../../demo-workspace/workspace.css';
import { createDemoWorkspaceAdapter } from './slots/demo-workspace-adapter.ts';
import type { WorkspaceAdapter } from './slots/workspace-adapter.ts';
import { createAgentApi } from './api.ts';
import type { FetchLike } from './api.ts';
import { AgentBrain } from './brain/agent-brain.ts';
import { createDirectorPresenter } from './clipa/director-presenter.ts';
import { InputGuard, watchPageInput } from './clipa/input-guard.ts';
import { createClipaStore } from './clipa/presenter.ts';
import type { ClipaStore } from './clipa/presenter.ts';
import { resolveClipaTarget } from './clipa/targets.ts';
import { API_BASE } from './config.ts';
import { ShellController } from './controller.ts';
import type { ControllerTimers, KeyValueStorage } from './controller.ts';
import { SampleObservationSource } from './screen/sample-source.ts';
import { createBridgeMount } from './screen/bridge-mount.ts';
import { LiveMount } from './screen/live-mount.ts';
import { SAMPLE_CUSTOMERS } from './screen/sample-scenarios.ts';
import type { CreateRuntimeWorkspace } from './screen/runtime-workspace-source.ts';
import { connectElevenLabs } from './voice/elevenlabs.ts';

export interface ShellRuntime {
  controller: ShellController;
  clipa: ClipaStore;
  /** Stream A's demo workspace behind the seam of slots/workspace-adapter.ts; null until it is wired (the slot shows stand-ins). */
  workspace: WorkspaceAdapter | null;
  /** Stream A's integrated runtime (real bridge, screen panel, workspace) mounted per session; null until A's commit is on main. */
  live: LiveMount | null;
  /** Removes the Clipa layer and the page listeners. The controller is disposed separately. */
  dispose(): void;
}

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
 * The real screen, mounted per session: stream A's capture, ScreenBridge and screen panel (PR #21), composed in bridge-mount.ts.
 * Stream A's `createRuntimeWorkspace` (the same plus the demo workspace and its checkpoint adapter; not on main yet) replaces this
 * one line when it lands: import it and assign it here, nothing else in the shell changes.
 */
const liveFactory: CreateRuntimeWorkspace = createBridgeMount;

export function createRuntime(): ShellRuntime {
  const store = createClipaStore();
  // The director logs refused or illegal commands: they go to the debug log once the controller exists.
  let note: (type: string, text: string) => void = () => {};
  const guard = new InputGuard(() => performance.now());
  const stopWatching = watchPageInput(guard, document);
  const director = createClipaDirector({
    root: document.body,
    dock: 'bottom-right',
    resolveTarget: (target) => resolveClipaTarget(document, target),
    isInputActive: () => guard.isActive(),
    onLog: (entry) => note('CLIPA', `${entry.kind}: ${entry.message}`),
  });
  const presenter = createDirectorPresenter({ store, director, guard });

  // An arrow function: an unbound window.fetch would throw "Illegal invocation".
  const fetchFn: FetchLike = (input, init) => fetch(input, init);
  const now = (): number => Date.now();
  const api = createAgentApi({ base: API_BASE, fetch: fetchFn, now, newId });
  const controller = new ShellController({
    api,
    fetch: fetchFn,
    connectVoice: connectElevenLabs,
    // The real policy, Work Map and tutor of packages/agent (TASK-3.29); model calls go through the session's LLM route.
    createBrain: (log) => new AgentBrain({ log, customers: SAMPLE_CUSTOMERS }),
    createSampleSource: (scenario) => new SampleObservationSource(now, browserTimers, scenario),
    presenter,
    now,
    perfNow: () => performance.now(),
    timers: browserTimers,
    isHidden: () => document.hidden,
    storage: browserStorage,
  });
  note = (type, text) => controller.note(type, text);
  // providesWorkspace: false while the factory is the screen-only bridge mount; true with A's createRuntimeWorkspace.
  const live = new LiveMount({ factory: liveFactory, controller, apiBase: API_BASE, providesWorkspace: false });
  // The sample source is the labelled fallback for when no screen is shared: it runs until the person shares a window in the panel.
  void controller.setSampleObservations(true);
  return {
    controller,
    clipa: store,
    // Stream A's demo workspace; its checkpoint port (A's adapter over the real bridge, PR #21) plugs in here when it lands.
    workspace: createDemoWorkspaceAdapter(),
    live,
    dispose() {
      live?.dispose();
      stopWatching();
      presenter.dispose();
    },
  };
}
