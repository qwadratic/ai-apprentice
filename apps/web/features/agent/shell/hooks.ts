import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ShellRuntime } from './runtime.ts';
import type { ShellState } from './state/types.ts';

export const ShellContext = createContext<ShellRuntime | null>(null);

export function useShell(): ShellRuntime {
  const runtime = useContext(ShellContext);
  if (!runtime) throw new Error('useShell must be used inside <AppShell>');
  return runtime;
}

/** Reads a slice of the shell state. The selector must return a stable reference (a slice of the state, not a new object). */
export function useShellState<T>(select: (state: ShellState) => T): T {
  const { controller } = useShell();
  const { store } = controller;
  return useSyncExternalStore(store.subscribe, () => select(store.getState()), () => select(store.getState()));
}

/** Date.now(), refreshed every `intervalMs` while `active`. */
export function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}
