// Launch page: draws the "Run now" cards, then starts the deploy status and the PR queue.
// Team page for the hackathon; the product app replaces it. No framework, no bundler: tsc turns src/ into plain
// ES modules in dist/. The page holds no tokens or keys and reads only public endpoints (see config.ts).
import { CARDS } from './cards.ts';
import type { Card, CardTone } from './cards.ts';
import { byId, chip, el, link } from './dom.ts';
import type { Tone } from './dom.ts';
import { initQueue } from './queue.ts';
import { initStatus } from './status.ts';

const CHIP_TONES: Record<CardTone, Tone> = { live: 'good', pending: 'warn', next: 'info' };

function renderCard(card: Card): HTMLLIElement {
  const button = link(card.action.label, card.action.href, card.chip.tone === 'live' ? 'btn btn-primary' : 'btn');
  const li = el(
    'li',
    'card',
    el('div', 'card-head', el('h3', undefined, card.title), chip(card.chip.text, CHIP_TONES[card.chip.tone])),
    el('p', undefined, card.summary),
    button,
  );
  li.dataset['card'] = card.id;
  return li;
}

byId('cards', HTMLUListElement).replaceChildren(...CARDS.map(renderCard));

initStatus({
  section: byId('status', HTMLElement),
  list: byId('statusRows', HTMLUListElement),
  refresh: byId('statusRefresh', HTMLButtonElement),
  updated: byId('statusUpdated', HTMLElement),
});

initQueue({
  section: byId('queue', HTMLElement),
  summary: byId('queueSummary', HTMLElement),
  body: byId('queueBody', HTMLElement),
  refresh: byId('queueRefresh', HTMLButtonElement),
});
