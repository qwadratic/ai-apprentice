import type { Action } from './reducer.ts';
import { initialState, reduce } from './reducer.ts';
import type { Persona, ShellState } from './types.ts';

/** A minimal external store: React reads it with useSyncExternalStore, the controller with getState(). */
export interface Store {
  getState(): ShellState;
  dispatch(action: Action): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(persona?: Persona): Store {
  let state = initialState(persona);
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
