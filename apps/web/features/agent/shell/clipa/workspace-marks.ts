// The Clipa marks on stream A's demo workspace: data-clipa-surface / data-clipa-hint attributes (no look change) on the workspace's
// own elements, so that Clipa can fly to the message body, the attachments, Preview and Send. No import of A's code.
import { HINT_ATTR, SURFACE_ATTR } from './targets.ts';

/** [selector inside the workspace, surface, hint]. The selectors are the workspace's own data attributes. */
export const CLIPA_MARKS: ReadonlyArray<readonly [string, string, string | null]> = [
  ['[data-surface="order"]', 'order', null],
  ['[data-surface="email"]', 'email', null],
  ['[data-surface="ticket"]', 'ticket', null],
  ['[data-field="recipient"]', 'email', 'recipient'],
  ['[data-field="body"]', 'email', 'body'],
  ['[data-view="attachments"]', 'email', 'attachments'],
  ['[data-action="preview"]', 'email', 'preview'],
  ['[data-action="send"]', 'email', 'send'],
];

interface Markable {
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
}

/** Puts the Clipa marks on the elements that exist. Returns how many it marked. */
export function markClipaTargets(root: Markable): number {
  let marked = 0;
  for (const [selector, surface, hint] of CLIPA_MARKS) {
    const el = root.querySelector(selector);
    if (el === null) continue;
    el.setAttribute(SURFACE_ATTR, surface);
    if (hint !== null) el.setAttribute(HINT_ATTR, hint);
    marked += 1;
  }
  return marked;
}

