// The only surface through which the shell talks to Clipa. The views never import the web component:
// TASK-3.28 (the motion director) can implement ClipaPresenter and replace ClipaAgent.tsx without touching them.

export const CLIPA_STATES = ['idle', 'listening', 'thinking', 'speaking', 'warning', 'happy', 'pointing', 'off'] as const;
export type ClipaState = (typeof CLIPA_STATES)[number];

/** A rectangle in viewport (client) coordinates. */
export interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClipaPresenter {
  setState(state: ClipaState): void;
  /** Shows the text in Clipa's bubble. An empty string clears the bubble. */
  say(text: string): void;
  /** Where Clipa should point. null: nowhere. */
  setTarget(rect: TargetRect | null): void;
}

export interface ClipaSnapshot {
  readonly state: ClipaState;
  readonly bubble: string;
  readonly target: TargetRect | null;
}

/** A presenter that also exposes its state to React (useSyncExternalStore). */
export interface ClipaStore extends ClipaPresenter {
  getSnapshot(): ClipaSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createClipaStore(): ClipaStore {
  let snapshot: ClipaSnapshot = { state: 'idle', bubble: '', target: null };
  const listeners = new Set<() => void>();
  const update = (next: ClipaSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    setState(state) { if (state !== snapshot.state) update({ ...snapshot, state }); },
    say(text) { if (text !== snapshot.bubble) update({ ...snapshot, bubble: text }); },
    setTarget(rect) { update({ ...snapshot, target: rect }); },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type PointDirection = 'up-left' | 'left' | 'down-left' | 'up-right' | 'right' | 'down-right';

/** Which way the pointing arm should face, from Clipa's own box to the target box. */
export function pointDirection(from: TargetRect, to: TargetRect): PointDirection {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const side = dx >= 0 ? 'right' : 'left';
  // A target roughly level with Clipa is "left" or "right"; above or below it, a diagonal.
  if (Math.abs(dy) <= Math.max(24, Math.abs(dx) * 0.25)) return side;
  const vertical = dy < 0 ? 'up' : 'down';
  return `${vertical}-${side}` as PointDirection;
}
