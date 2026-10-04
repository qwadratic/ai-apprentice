import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { useConductor } from './hooks.ts';
import { previewRect } from './targets.ts';
import type { Rect } from './targets.ts';

const same = (a: Rect | null, b: Rect | null): boolean =>
  a !== null && b !== null && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/**
 * The regions the conductor points at (an `ask`, a `warn` or a `point` cue), outlined over the live screen preview. Boxes are
 * normalised 0..1 to the frame the vision step read, and the preview canvas shows that frame at its own aspect ratio, so a box is
 * a percentage of the canvas. The overlay sits in `container` (position: relative) and is re-measured while it is shown.
 */
export function RegionOverlay({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const regions = useConductor((s) => s.regions);
  const paused = useConductor((s) => s.paused);
  const [frame, setFrame] = useState<Rect | null>(null);
  const shown = regions.length > 0 && !paused;

  useEffect(() => {
    if (!shown) { setFrame(null); return undefined; }
    const measure = (): void => {
      const container = containerRef.current;
      const preview = previewRect(document);
      if (container === null || preview === null) { setFrame(null); return; }
      const c = container.getBoundingClientRect();
      const next = { left: preview.left - c.left, top: preview.top - c.top, width: preview.width, height: preview.height };
      setFrame((prev) => (same(prev, next) ? prev : next));
    };
    measure();
    const id = window.setInterval(measure, 250);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', measure);
    };
  }, [shown, containerRef]);

  if (!shown || frame === null) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="region-overlay"
      style={{ position: 'absolute', left: frame.left, top: frame.top, width: frame.width, height: frame.height, pointerEvents: 'none', zIndex: 3 }}
    >
      {regions.map((r) => r.box !== null && (
        <div
          key={r.regionId}
          data-region-id={r.regionId}
          style={{
            position: 'absolute',
            left: `${r.box[0] * 100}%`,
            top: `${r.box[1] * 100}%`,
            width: `${r.box[2] * 100}%`,
            height: `${r.box[3] * 100}%`,
            border: '2px solid #14b8a6',
            borderRadius: 6,
            boxShadow: '0 0 0 3px rgba(20, 184, 166, 0.28)',
          }}
        >
          {r.label !== '' && (
            <span
              style={{
                position: 'absolute', left: -2, bottom: '100%', marginBottom: 4, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis',
                background: '#0f766e', color: '#ffffff', font: '600 12px/1.6 system-ui, sans-serif', padding: '0 6px', borderRadius: 4, whiteSpace: 'nowrap',
              }}
            >
              {r.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
