// The "Run now" cards. Adding, changing or removing a card is one object in CARDS.
//   chip.tone: live = running on Pages now, pending = in an open PR, next = planned.
//   action.href: "./..." stays in this tab; "https://..." opens in a new tab.
import { prUrl } from './config.ts';

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
    id: 'product-app',
    title: 'AI Apprentice app',
    summary: 'The product: Learn, Review and Teach with Clipa, screen sharing and voice. Built from main on every release; the shell is being wired in.',
    chip: { text: 'live', tone: 'live' },
    action: { label: 'Open the app', href: '../' },
  },
  {
    id: 'demo-workspace',
    title: 'Demo workspace (stream A)',
    summary: 'The order, email and ticket flow with the Preview/Send checkpoint; not on Pages yet.',
    chip: { text: 'in PR #12', tone: 'pending' },
    action: { label: 'Open PR #12', href: prUrl(12) },
  },
];
