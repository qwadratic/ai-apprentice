import type { FeedKind } from './model.ts';

// One small line icon per kind of feed item (16 px grid, stroke in currentColor). Decorative: the item's label says the kind.
const PATHS: Record<FeedKind, string[]> = {
  screen: ['M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z', 'M6 14h4', 'M8 11.5V14'],
  ask: ['M3 2.5h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8.5L5.5 14v-3H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z', 'M6.6 5.4a1.45 1.45 0 1 1 2 1.35c-.4.18-.6.48-.6.9', 'M8 9.1v.1'],
  answer: ['M8 2a2 2 0 0 1 2 2v3.5a2 2 0 0 1-4 0V4a2 2 0 0 1 2-2z', 'M4 7.5a4 4 0 0 0 8 0', 'M8 11.5V14', 'M6 14h4'],
  rule: ['M8 1.8l5 2v4.1c0 3-2.1 5.1-5 6.3-2.9-1.2-5-3.3-5-6.3V3.8z', 'M5.9 8.1l1.5 1.5 2.8-3'],
  map: ['M4 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z', 'M12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z', 'M5.5 4h4.3a2 2 0 0 1 0 4H6.2a2 2 0 0 0 0 4h4.3'],
  warn: ['M8 2.2l6.2 11H1.8z', 'M8 6.4v3.2', 'M8 11.4v.1'],
  say: ['M3 2.5h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8.5L5.5 14v-3H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z', 'M5 5.6h6', 'M5 8h4'],
  check: ['M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2z', 'M5.4 8.2l1.8 1.8 3.4-3.7'],
};

export function FeedIcon({ kind }: { kind: FeedKind }) {
  return (
    <svg className="as-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[kind].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
