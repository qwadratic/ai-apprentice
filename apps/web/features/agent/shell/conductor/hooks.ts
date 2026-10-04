import { useSyncExternalStore } from 'react';
import { useShell } from '../hooks.ts';
import type { ConductorState } from './store.ts';

/** Reads a slice of the conductor's state. The selector must return a stable reference (a slice, not a new object). */
export function useConductor<T>(select: (state: ConductorState) => T): T {
  const { controller } = useShell();
  const store = controller.conductorStore;
  return useSyncExternalStore(store.subscribe, () => select(store.getState()), () => select(store.getState()));
}

/** True while the conductor leads this page (its client runs and the server did not refuse it). */
export function useConductorLeads(): boolean {
  return useConductor((s) => s.enabled && s.status !== 'failed');
}
