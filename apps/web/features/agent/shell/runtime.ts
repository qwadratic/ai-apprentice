// Wires the real world (browser fetch, timers, ElevenLabs, localStorage, the Clipa motion director) into the controller.
import { createClipaDirector } from '../clipa/src/index.ts';
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
import { SAMPLE_CUSTOMERS } from './screen/sample-scenarios.ts';
import { connectElevenLabs } from './voice/elevenlabs.ts';

export interface ShellRuntime {
  controller: ShellController;
  clipa: ClipaStore;
  /** Stream A's demo workspace behind the seam of slots/workspace-adapter.ts; null until it is wired (the slot shows stand-ins). */
  workspace: WorkspaceAdapter | null;
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
  // The sample source is the only observation source until stream A's bridge is wired in: it is on, and labelled synthetic.
  void controller.setSampleObservations(true);
  return {
    controller,
    clipa: store,
    workspace: null,
    dispose() {
      stopWatching();
      presenter.dispose();
    },
  };
}
