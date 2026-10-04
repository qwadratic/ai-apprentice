// The adapter from WorkspaceActions to stream A's demo workspace (apps/web/features/demo-workspace). It does not import A's
// code: it works on the page the way a person does, through the workspace's stable data-field / data-action / data-view
// attributes. If A changes its markup, the selectors below are the only thing to update; if A publishes another mount
// (createRuntimeWorkspace), this adapter keeps working as long as the mount renders the same attributes.
import { createRng, jittered } from './clock.ts';
import type { Clock } from './clock.ts';
import { HUMAN_TYPING, reactionMs, typeLikeAHuman } from './typing.ts';
import type { TypingProfile } from './typing.ts';
import type { CheckResult, CheckStatus, EmailView, OrderView, TextTarget, WorkspaceActions } from './workspace-actions.ts';

/** Stable selectors of the demo workspace as of main e810297 (ui.ts). */
export const DEMO_SELECTORS = {
  caseSelect: '[data-field="case"]',
  orderTitle: '[data-view="order-title"]',
  orderCustomer: '[data-field="order-customer"]',
  address: '[data-field="address"]',
  window: '[data-field="window"]',
  body: '[data-field="body"]',
  ticket: '[data-field="ticket"]',
  attachmentFigure: '[data-view="attachments"] figure',
  removeImage: '[data-view="attachments"] figure button',
  attach: '[data-action="attach"]',
  preview: '[data-action="preview"]',
  checkPanel: '[data-view="check-panel"]',
  checkMessage: '[data-view="check-message"]',
  ackPanel: '[data-view="ack-panel"]',
  ack: '[data-field="ack"]',
  send: '[data-action="send"]',
  sent: '[data-view="sent"]',
  resolve: '[data-action="resolve"]',
} as const;
export type DemoSelectors = { [K in keyof typeof DEMO_SELECTORS]: string };

/** What the adapter needs from the page. The real one is createDomPort; tests pass a fake. */
export interface DomPort {
  exists(selector: string): boolean;
  count(selector: string): number;
  text(selector: string): string;
  attr(selector: string, name: string): string | null;
  value(selector: string): string;
  isChecked(selector: string): boolean;
  isDisabled(selector: string): boolean;
  isHidden(selector: string): boolean;
  /** Moves the visible cursor to the element (a no-op without a cursor). */
  pointAt(selector: string): Promise<void>;
  click(selector: string): void;
  focus(selector: string): void;
  /** Writes a value and fires the event a person's edit fires: 'input' for fields, 'change' for a select. */
  setValue(selector: string, value: string, event: 'input' | 'change'): void;
}

const CHECK_STATUSES: readonly CheckStatus[] = ['idle', 'pending', 'clear', 'warn', 'unknown', 'error'];
const POLL_MS = 200;

export interface DemoWorkspaceActionsOptions {
  port: DomPort;
  clock: Clock;
  rng?: () => number;
  typing?: TypingProfile;
  selectors?: Partial<DemoSelectors>;
}

export function createDemoWorkspaceActions(options: DemoWorkspaceActionsOptions): WorkspaceActions {
  const { port, clock } = options;
  const rng = options.rng ?? createRng(7);
  const profile = options.typing ?? HUMAN_TYPING;
  const sel: DemoSelectors = { ...DEMO_SELECTORS, ...options.selectors };

  /** A person points at the thing, takes a moment, then clicks. */
  const click = async (selector: string): Promise<void> => {
    await port.pointAt(selector);
    await clock.sleep(reactionMs(rng, 300));
    port.click(selector);
  };

  const check = (): CheckResult => {
    const raw = port.attr(sel.checkPanel, 'data-status') ?? 'idle';
    const status = CHECK_STATUSES.find((s) => s === raw) ?? 'error';
    return { status, message: port.text(sel.checkMessage).trim() };
  };

  const isSent = (): boolean => port.text(sel.sent).trim().length > 0;

  return {
    async openOrder(caseId) {
      await port.pointAt(sel.caseSelect);
      await clock.sleep(reactionMs(rng, 400));
      if (port.value(sel.caseSelect) !== caseId) port.setValue(sel.caseSelect, caseId, 'change');
      if (port.value(sel.caseSelect) !== caseId) throw new Error(`the workspace has no case "${caseId}"`);
      // The order card changes; a person looks at it before doing anything.
      await port.pointAt(sel.address);
    },
    readOrder(): OrderView {
      const customer = port.value(sel.orderCustomer).trim();
      return {
        orderId: port.text(sel.orderTitle).trim(),
        customer: customer.length > 0 ? customer : null,
        address: port.value(sel.address).trim(),
        window: port.value(sel.window).trim(),
      };
    },
    readEmail(): EmailView {
      return { body: port.value(sel.body), attachments: port.count(sel.attachmentFigure) };
    },
    async removeImage() {
      if (port.count(sel.attachmentFigure) === 0) return;
      await click(sel.removeImage);
    },
    async attachImage() {
      if (port.isDisabled(sel.attach)) return;
      await click(sel.attach);
    },
    async typeText(target: TextTarget, text: string, mode) {
      const field = target === 'body' ? sel.body : sel.ticket;
      await port.pointAt(field);
      await clock.sleep(reactionMs(rng, 350));
      port.focus(field);
      if (mode === 'replace' && port.value(field).length > 0) {
        // Select all and delete: one edit, then the typing starts.
        port.setValue(field, '', 'input');
        await clock.sleep(jittered(rng, 400, 0.3));
      }
      await typeLikeAHuman(text, (char) => port.setValue(field, port.value(field) + char, 'input'), clock, rng, profile);
    },
    async preview() {
      await click(sel.preview);
    },
    checkResult: check,
    async waitForCheck(timeoutMs) {
      const until = clock.now() + timeoutMs;
      // The workspace turns "pending" on at once; a poll that still sees "idle" right after Preview waits one round.
      await clock.sleep(POLL_MS);
      let result = check();
      while (result.status === 'pending' && clock.now() < until) {
        await clock.sleep(POLL_MS);
        result = check();
      }
      return result;
    },
    async acknowledge() {
      if (port.isHidden(sel.ackPanel) || port.isChecked(sel.ack)) return;
      await click(sel.ack);
    },
    async send() {
      if (port.isDisabled(sel.send)) return false;
      await click(sel.send);
      return isSent();
    },
    isSent,
    async resolveTicket() {
      if (port.isDisabled(sel.resolve)) return;
      await click(sel.resolve);
    },
  };
}

/** The pointer the real port flies to the target before clicking: the simulated desktop's cursor. */
export interface PointerLike {
  moveTo(target: Element): Promise<void>;
}

/** The port for a real page: `root` is the element that holds the workspace. */
export function createDomPort(root: ParentNode, pointer?: PointerLike): DomPort {
  const find = (selector: string): Element => {
    const found = root.querySelector(selector);
    if (!found) throw new Error(`the workspace has no element ${selector}`);
    return found;
  };
  const field = (selector: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
    const el = find(selector);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el;
    throw new Error(`${selector} is not a form field`);
  };
  const html = (selector: string): HTMLElement => {
    const el = find(selector);
    if (el instanceof HTMLElement) return el;
    throw new Error(`${selector} is not an HTML element`);
  };
  return {
    exists: (selector) => root.querySelector(selector) !== null,
    count: (selector) => root.querySelectorAll(selector).length,
    text: (selector) => root.querySelector(selector)?.textContent ?? '',
    attr: (selector, name) => root.querySelector(selector)?.getAttribute(name) ?? null,
    value: (selector) => field(selector).value,
    isChecked: (selector) => {
      const el = field(selector);
      return el instanceof HTMLInputElement && el.checked;
    },
    isDisabled: (selector) => {
      const el = root.querySelector(selector);
      return el === null || (el instanceof HTMLButtonElement && el.disabled);
    },
    isHidden: (selector) => {
      const el = root.querySelector(selector);
      return el === null || (el instanceof HTMLElement && Boolean(el.hidden));
    },
    pointAt: async (selector) => {
      if (pointer) await pointer.moveTo(find(selector));
    },
    click: (selector) => html(selector).click(),
    focus: (selector) => html(selector).focus(),
    setValue: (selector, value, event) => {
      const el = field(selector);
      // The native setter, so a framework that wraps the value property still sees the edit.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event(event, { bubbles: true }));
    },
  };
}
