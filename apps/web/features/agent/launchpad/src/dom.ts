// Small DOM helpers. Text that came from the network (PR titles, logins, messages) only ever becomes a text node
// through append(): this page never uses innerHTML.
import { commitUrl } from './config.ts';
import { ageText, shortSha } from './model.ts';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'muted';
export type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

// Looks an element up by id and checks its type; the page markup is ours, so a miss is a build error.
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`index.html: #${id} is missing or has the wrong type`);
  return node;
}

export const chip = (text: string, tone: Tone): HTMLSpanElement => el('span', `chip chip-${tone}`, text);

export const code = (text: string): HTMLElement => el('code', undefined, text);

/** A link. Only "./..." and "https://..." targets become links (never javascript: or data:); https ones open in a new tab. */
export function link(content: Child, href: string, className?: string): HTMLElement {
  const external = href.startsWith('https://');
  if (!external && !href.startsWith('./')) return el('span', className, content);
  const a = el('a', className, content);
  a.href = href;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return a;
}

/** The short sha as a link to its commit. The sha has been validated as hex by model.asSha. */
export const shaLink = (sha: string): HTMLElement => link(code(shortSha(sha)), commitUrl(sha));

const DATE_TIME: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' };

export const formatDateTime = (d: Date): string => d.toLocaleString(undefined, DATE_TIME);
export const formatClock = (d: Date): string => d.toLocaleTimeString(undefined, CLOCK);

/** A <time> with the age as text ("3 h ago") and the exact local time as its tooltip; `exact` writes that time out as well. */
export function timeEl(d: Date, now: Date, exact = false): HTMLElement {
  const age = ageText(d, now);
  const t = el('time', undefined, exact ? `${formatDateTime(d)} (${age})` : age);
  t.dateTime = d.toISOString();
  t.title = formatDateTime(d);
  return t;
}
