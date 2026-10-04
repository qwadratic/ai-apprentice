// What a persona can do in the workspace, as one small interface. The driver (driver.ts) runs scripted tasks against it and
// knows nothing about the DOM; workspace-dom.ts implements it for stream A's demo workspace (apps/web/features/demo-workspace),
// and a test double implements it for the unit tests. If A's mount changes, only the implementation changes.

/**
 * What the check panel shows. Mirrors the workspace's check states ('sent' is not one of them, see isSent): 'acquiring' is
 * the wait for fresh screen evidence (vision), 'pending' the wait for the agent's reply; both mean "not answered yet".
 */
export type CheckStatus = 'idle' | 'acquiring' | 'pending' | 'clear' | 'warn' | 'unknown' | 'error';

export interface CheckResult {
  status: CheckStatus;
  message: string;
}

/** The order the persona is looking at: what it copies into the message. Read from the screen, never from a script. */
export interface OrderView {
  orderId: string;
  customer: string | null;
  address: string;
  window: string;
}

export interface EmailView {
  body: string;
  /** How many image attachments the draft has. */
  attachments: number;
}

export type TextTarget = 'body' | 'ticket';

export interface WorkspaceActions {
  /** Opens a case (an order with its draft) by its id in the workspace's case list. */
  openOrder(caseId: string): Promise<void>;
  readOrder(): OrderView;
  readEmail(): EmailView;
  removeImage(): Promise<void>;
  attachImage(): Promise<void>;
  /** Types into the message body or the ticket note, key by key. 'replace' clears the text first. */
  typeText(target: TextTarget, text: string, mode: 'replace' | 'append'): Promise<void>;
  /** Presses Preview (the check before Send). */
  preview(): Promise<void>;
  /** The check as it is now. */
  checkResult(): CheckResult;
  /** Waits until the check is no longer acquiring or pending (or the time is up) and returns it. */
  waitForCheck(timeoutMs: number): Promise<CheckResult>;
  /** Ticks "I have reviewed the warning" (needed before Send after a warning or an unknown). */
  acknowledge(): Promise<void>;
  /** Presses Send. Resolves whether the email went out. */
  send(): Promise<boolean>;
  isSent(): boolean;
  /** Marks the ticket resolved. */
  resolveTicket(): Promise<void>;
}
