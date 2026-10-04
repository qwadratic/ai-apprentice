// "Is the person typing?" The motion director never starts a flight while this is true (and sends Clipa home if it turns true
// while she waits for an answer). Two sources: real key presses anywhere in the page (a correction typed into Review, a note in
// the workspace once it is mounted) and the workspace's `input_activity` heartbeats (typing true or false), which also cover
// typing the page cannot see, such as the sample source's scripted expert. Time is injected, so the guard is unit-tested.
export const INPUT_QUIET_MS = 1200;
/** A `typing: true` heartbeat that is not repeated stops counting after this long (heartbeats come every 2 s while typing). */
export const HEARTBEAT_TTL_MS = 3000;

export class InputGuard {
  private readonly now: () => number;
  private readonly quietMs: number;
  private lastKeyAtMs = Number.NEGATIVE_INFINITY;
  private lastTypingAtMs = Number.NEGATIVE_INFINITY;
  private typing = false;

  constructor(now: () => number, quietMs: number = INPUT_QUIET_MS) {
    this.now = now;
    this.quietMs = quietMs;
  }

  /** A key was pressed or text was entered. */
  noteInput(): void {
    this.lastKeyAtMs = this.now();
  }

  /** A workspace heartbeat: the person is typing, or has stopped. */
  setTyping(typing: boolean): void {
    this.typing = typing;
    if (typing) this.lastTypingAtMs = this.now();
  }

  isActive(): boolean {
    const t = this.now();
    if (t - this.lastKeyAtMs < this.quietMs) return true;
    return this.typing && t - this.lastTypingAtMs < HEARTBEAT_TTL_MS;
  }
}

/** Listens for key presses and input events anywhere in the page. Returns the function that removes the listeners. */
export function watchPageInput(guard: InputGuard, target: Pick<Document, 'addEventListener' | 'removeEventListener'>): () => void {
  const onInput = (): void => guard.noteInput();
  target.addEventListener('keydown', onInput, true);
  target.addEventListener('input', onInput, true);
  return () => {
    target.removeEventListener('keydown', onInput, true);
    target.removeEventListener('input', onInput, true);
  };
}
