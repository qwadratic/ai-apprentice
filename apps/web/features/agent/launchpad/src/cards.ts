// The "Run now" cards. Adding, changing or removing a card is one object in CARDS.
//   chip.tone: live = running on Pages now, pending = in an open PR, next = planned.
//   action.href: "./..." stays in this tab; "https://..." opens in a new tab.
import { BACKLOG_TASKS_URL, prUrl } from './config.ts';

export type CardTone = 'live' | 'pending' | 'next';

export interface Card {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly chip: { readonly text: string; readonly tone: CardTone };
  readonly action: { readonly label: string; readonly href: string };
}

export const CARDS: readonly Card[] = [
  {
    id: 'agent-lab',
    title: 'Agent lab',
    summary: 'Talk to Clipa, the ElevenLabs voice agent, while mock screen events play.',
    chip: { text: 'live', tone: 'live' },
    action: { label: 'Open the lab', href: './lab/' },
  },
  {
    id: 'demo-workspace',
    title: 'Demo workspace (stream A)',
    summary: 'The order, email and ticket flow with the Preview/Send checkpoint; not on Pages yet.',
    chip: { text: 'in PR #12', tone: 'pending' },
    action: { label: 'Open PR #12', href: prUrl(12) },
  },
  {
    id: 'web-foundation',
    title: 'Web foundation (stream A)',
    summary: 'The ScreenBridge contract and the web app scaffold; not on Pages yet.',
    chip: { text: 'in PR #14', tone: 'pending' },
    action: { label: 'Open PR #14', href: prUrl(14) },
  },
  {
    id: 'product-app',
    title: 'Product app (Learn / Review / Teach)',
    summary: 'The app for the three modes that replaces this page.',
    chip: { text: 'next', tone: 'next' },
    action: { label: 'Open the task list', href: BACKLOG_TASKS_URL },
  },
];
