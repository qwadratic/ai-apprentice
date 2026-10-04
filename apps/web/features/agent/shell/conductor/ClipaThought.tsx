// Clipa's thought bubble: the conductor's latest `thought` cue as a short italic line beside the floating Clipa, with the two
// small dots of a thought trailing towards her. Visual only: it is never spoken, and screen readers skip it (aria-hidden).
// It is position: fixed, so it never shifts the layout; the face removes it after THOUGHT_MS and the CSS fades it in and out.
// While it shows it follows Clipa (the director's actor), who may be flying.
import { useEffect, useRef } from 'react';
import { useConductor } from './hooks.ts';
import { THOUGHT_MS } from './face.ts';

/** The floating Clipa's box (the director's actor). */
export const CLIPA_ACTOR_SELECTOR = '.clipa-layer .clipa-actor';
const MARGIN = 8;
const GAP = 6;

export interface Box { left: number; top: number; width: number; height: number }

/**
 * Where the bubble goes: above Clipa, its tail end near her head, on the side with room (left first: she rests at the right);
 * below her when there is no room above. Always inside the viewport. Pure.
 */
export function thoughtPosition(clipa: Box, bubble: { w: number; h: number }, viewport: { w: number; h: number }): { left: number; top: number; side: 'left' | 'right' } {
  const head = clipa.left + clipa.width / 2;
  const side: 'left' | 'right' = head - bubble.w >= MARGIN ? 'left' : 'right';
  const left = side === 'left' ? head - bubble.w + clipa.width * 0.15 : head - clipa.width * 0.15;
  let top = clipa.top - bubble.h - GAP;
  if (top < MARGIN) top = clipa.top + clipa.height + GAP;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return { left: clamp(left, MARGIN, viewport.w - bubble.w - MARGIN), top: clamp(top, MARGIN, viewport.h - bubble.h - MARGIN), side };
}

export function ClipaThought() {
  const thought = useConductor((s) => s.thought);
  const paused = useConductor((s) => s.paused);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (thought === null || el === null || typeof document === 'undefined') return;
    let frame = 0;
    const until = performance.now() + THOUGHT_MS;
    const place = (): void => {
      const rect = document.querySelector(CLIPA_ACTOR_SELECTOR)?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const pos = thoughtPosition(rect, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
        el.style.transform = `translate(${pos.left.toFixed(1)}px, ${pos.top.toFixed(1)}px)`;
        el.dataset['side'] = pos.side;
        el.dataset['placed'] = '';
      }
      if (performance.now() < until) frame = window.requestAnimationFrame(place);
    };
    place();
    return () => window.cancelAnimationFrame(frame);
  }, [thought]);
  if (thought === null || paused) return null;
  return (
    <div key={thought.cueId} ref={ref} className="as-thought" data-testid="clipa-thought" aria-hidden="true">
      <span className="as-thought__text">{thought.text}</span>
      <span className="as-thought__dot as-thought__dot--big" />
      <span className="as-thought__dot as-thought__dot--small" />
    </div>
  );
}
