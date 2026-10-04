import { HIDDEN_LIMIT_MS, SESSION_LIMIT_MS } from './session-clock.ts';

export interface LimitTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionLimitsOptions {
  timers: LimitTimers;
  onExpire: (reason: string) => void;
  sessionMs?: number;
  hiddenMs?: number;
}

/** The two safety caps of a public page: 10 minutes in all, 2 minutes with the tab hidden. */
export class SessionLimits {
  private readonly timers: LimitTimers;
  private readonly onExpire: (reason: string) => void;
  private readonly sessionMs: number;
  private readonly hiddenMs: number;
  private sessionTimer: unknown = null;
  private hiddenTimer: unknown = null;
  private running = false;

  constructor(options: SessionLimitsOptions) {
    this.timers = options.timers;
    this.onExpire = options.onExpire;
    this.sessionMs = options.sessionMs ?? SESSION_LIMIT_MS;
    this.hiddenMs = options.hiddenMs ?? HIDDEN_LIMIT_MS;
  }

  start(hidden: boolean): void {
    this.stop();
    this.running = true;
    this.sessionTimer = this.timers.setTimeout(() => {
      this.sessionTimer = null;
      if (this.running) this.expire(`Session auto-ended: the ${describe(this.sessionMs)} limit was reached.`);
    }, this.sessionMs);
    this.setHidden(hidden);
  }

  setHidden(hidden: boolean): void {
    if (!this.running) return;
    if (hidden) {
      if (this.hiddenTimer !== null) return;
      this.hiddenTimer = this.timers.setTimeout(() => {
        this.hiddenTimer = null;
        if (this.running) this.expire(`Session auto-ended: this tab was hidden for more than ${describe(this.hiddenMs)}.`);
      }, this.hiddenMs);
    } else if (this.hiddenTimer !== null) {
      this.timers.clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
  }

  stop(): void {
    this.running = false;
    if (this.sessionTimer !== null) this.timers.clearTimeout(this.sessionTimer);
    if (this.hiddenTimer !== null) this.timers.clearTimeout(this.hiddenTimer);
    this.sessionTimer = null;
    this.hiddenTimer = null;
  }

  private expire(reason: string): void {
    this.stop();
    this.onExpire(reason);
  }
}

function describe(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)} minute${ms >= 120000 ? 's' : ''}` : `${Math.round(ms / 1000)} seconds`;
}
