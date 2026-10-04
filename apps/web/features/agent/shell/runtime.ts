// Wires the real world (browser fetch, timers, ElevenLabs, localStorage) into the controller.
import { createAgentApi } from './api.ts';
import type { FetchLike } from './api.ts';
import { NullBrain } from './brain/null-brain.ts';
import { createClipaStore } from './clipa/presenter.ts';
import type { ClipaStore } from './clipa/presenter.ts';
import { API_BASE } from './config.ts';
import { ShellController } from './controller.ts';
import type { ControllerTimers, KeyValueStorage } from './controller.ts';
import { SampleObservationSource } from './screen/sample-source.ts';
import { connectElevenLabs } from './voice/elevenlabs.ts';

export interface ShellRuntime {
  controller: ShellController;
  clipa: ClipaStore;
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
  const clipa = createClipaStore();
  // An arrow function: an unbound window.fetch would throw "Illegal invocation".
  const fetchFn: FetchLike = (input, init) => fetch(input, init);
  const now = (): number => Date.now();
  const api = createAgentApi({ base: API_BASE, fetch: fetchFn, now, newId });
  const controller = new ShellController({
    api,
    fetch: fetchFn,
    connectVoice: connectElevenLabs,
    // The real policy, map and tutor (packages/agent, TASK-3.29) replace NullBrain here.
    createBrain: (log) => new NullBrain(log),
    createSampleSource: () => new SampleObservationSource(now, browserTimers),
    presenter: clipa,
    now,
    perfNow: () => performance.now(),
    timers: browserTimers,
    isHidden: () => document.hidden,
    storage: browserStorage,
  });
  return { controller, clipa };
}
