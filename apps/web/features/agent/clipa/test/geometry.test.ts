import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS,
  NOTICE_MS,
  RETREAT_MS,
  bezierPoint,
  boxAt,
  boxFromRect,
  center,
  dockCenter,
  easeInOutCubic,
  flightDuration,
  inflate,
  insideViewport,
  intersection,
  lookVector,
  overlapArea,
  overlaps,
  pathViolations,
  placeBeside,
  placeBubble,
  planFlightPath,
  pointDirection,
  sidesAwayFrom,
} from '../src/geometry.ts';
import type { Box, Size } from '../src/geometry.ts';

const VP: Size = { w: 1280, h: 800 };
const CLIPA: Size = { w: 89, h: 108 };
const MARGIN = 12;
const GAP = 14;

/** Small deterministic PRNG so the property tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);

describe('boxes', () => {
  it('converts rects, centres and inflates', () => {
    const b = boxFromRect({ left: 10, top: 20, width: 30, height: 40 });
    assert.deepEqual(b, { x: 10, y: 20, w: 30, h: 40 });
    assert.deepEqual(center(b), { x: 25, y: 40 });
    assert.deepEqual(inflate(b, 5), { x: 5, y: 15, w: 40, h: 50 });
    assert.deepEqual(boxAt({ x: 25, y: 40 }, { w: 30, h: 40 }), b);
  });

  it('counts touching boxes as not overlapping', () => {
    const a: Box = { x: 0, y: 0, w: 10, h: 10 };
    assert.equal(overlaps(a, { x: 10, y: 0, w: 10, h: 10 }), false);
    assert.equal(overlaps(a, { x: 9.5, y: 0, w: 10, h: 10 }), true);
    assert.equal(overlapArea(a, { x: 5, y: 5, w: 10, h: 10 }), 25);
    assert.equal(intersection(a, { x: 20, y: 20, w: 5, h: 5 }), null);
  });
});

describe('placeBeside', () => {
  const field: Box = { x: 400, y: 300, w: 400, h: 120 };

  it('prefers the right side, centred on the element', () => {
    const p = placeBeside(field, CLIPA, VP);
    assert.equal(p.side, 'right');
    assert.equal(p.box.x, field.x + field.w + GAP);
    assert.equal(center(p.box).y, center(field).y);
    assert.equal(p.overlap, 0);
    assert.equal(p.clamped, false);
  });

  it('goes left when there is no room on the right, then above, then below', () => {
    const atRightEdge: Box = { x: 1000, y: 300, w: 270, h: 100 };
    assert.equal(placeBeside(atRightEdge, CLIPA, VP).side, 'left');

    const fullWidth: Box = { x: 20, y: 300, w: 1240, h: 100 };
    const above = placeBeside(fullWidth, CLIPA, VP);
    assert.equal(above.side, 'top');
    assert.equal(above.box.y + above.box.h + GAP, fullWidth.y);

    const nearTop: Box = { x: 20, y: 40, w: 1240, h: 100 };
    const below = placeBeside(nearTop, CLIPA, VP);
    assert.equal(below.side, 'bottom');
    assert.equal(below.box.y, nearTop.y + nearTop.h + GAP);
  });

  it('follows a custom side order', () => {
    assert.equal(placeBeside(field, CLIPA, VP, { order: ['top', 'right'] }).side, 'top');
  });

  it('slides along the edge to stay inside the viewport, still beside the element', () => {
    const lowField: Box = { x: 400, y: 760, w: 300, h: 30 };
    const p = placeBeside(lowField, CLIPA, VP);
    assert.equal(p.side, 'right');
    assert.equal(p.clamped, true);
    assert.equal(p.box.y + p.box.h, VP.h - MARGIN);
    assert.ok(insideViewport(p.box, VP, MARGIN));
    assert.ok(p.box.x >= lowField.x + lowField.w + GAP);

    const highField: Box = { x: 400, y: 2, w: 300, h: 30 };
    const q = placeBeside(highField, CLIPA, VP);
    assert.equal(q.box.y, MARGIN);
    assert.equal(overlapArea(q.box, highField), 0);
  });

  it('centres on the visible part of an element that is half scrolled out', () => {
    const tall: Box = { x: 300, y: -500, w: 400, h: 700 }; // visible: y 0..200
    const p = placeBeside(tall, CLIPA, VP);
    assert.equal(p.side, 'right');
    assert.equal(center(p.box).y, 100);
    assert.ok(insideViewport(p.box, VP, MARGIN));
  });

  it('keeps the margin to every edge on a small viewport', () => {
    const phone: Size = { w: 390, h: 700 };
    const input: Box = { x: 16, y: 200, w: 358, h: 44 };
    const p = placeBeside(input, CLIPA, phone);
    assert.ok(insideViewport(p.box, phone, MARGIN), JSON.stringify(p));
    assert.equal(overlapArea(p.box, input), 0);
    assert.notEqual(p.side, 'right');
  });

  it('never overlaps the element and stays in the viewport, for 3000 random elements', () => {
    const r = rng(7);
    for (let i = 0; i < 3000; i++) {
      const w = between(r, 20, 400);
      const h = between(r, 16, 300);
      const target: Box = { x: between(r, -50, VP.w - w + 50), y: between(r, -40, VP.h - h + 40), w, h };
      const p = placeBeside(target, CLIPA, VP);
      assert.equal(overlapArea(p.box, target), 0, `overlap for ${JSON.stringify(target)} -> ${JSON.stringify(p)}`);
      assert.ok(insideViewport(p.box, VP, MARGIN), `outside for ${JSON.stringify(target)} -> ${JSON.stringify(p)}`);
      if (target.x + target.w + GAP + CLIPA.w <= VP.w - MARGIN && target.x + target.w >= 0) {
        assert.equal(p.side, 'right', `right fits for ${JSON.stringify(target)}`);
      }
    }
  });

  it('keeps room for the bubble: an element near the right edge makes her stand on another side', () => {
    const nearEdge: Box = { x: 928, y: 606, w: 230, h: 170 };
    const plain = placeBeside(nearEdge, CLIPA, VP);
    assert.equal(plain.side, 'right', 'without a reservation she fits on the right');
    assert.ok(placeBubble(plain.box, nearEdge, { w: 206, h: 80 }, VP).overlap > 0, 'but her bubble would have no room');
    const roomy = placeBeside(nearEdge, CLIPA, VP, { reserve: { w: 264, h: 100 } });
    assert.notEqual(roomy.side, 'right');
    assert.equal(placeBubble(roomy.box, nearEdge, { w: 206, h: 80 }, VP).overlap, 0);
  });

  it('falls back to the first side where she fits when no side leaves room for the bubble', () => {
    const wide: Box = { x: 100, y: 100, w: 1000, h: 600 };
    const p = placeBeside(wide, CLIPA, VP, { reserve: { w: 1200, h: 700 } });
    assert.equal(p.side, 'right');
    assert.equal(p.overlap, 0);
  });

  it('with an element that fills the viewport, picks the least bad side and reports the overlap', () => {
    const everything: Box = { x: 0, y: 0, w: VP.w, h: VP.h };
    const p = placeBeside(everything, CLIPA, VP);
    assert.ok(p.overlap > 0);
    assert.ok(insideViewport(p.box, VP, MARGIN));
    const candidates = (['right', 'left', 'top', 'bottom'] as const).map(
      (side) => placeBeside(everything, CLIPA, VP, { order: [side] }).overlap,
    );
    assert.equal(p.overlap, Math.min(...candidates));
  });
});

describe('placeBubble', () => {
  const bubble: Size = { w: 240, h: 72 };

  it('puts the bubble on the side of Clipa that faces away from the element', () => {
    const element: Box = { x: 300, y: 300, w: 300, h: 100 };
    const actor = placeBeside(element, CLIPA, VP).box; // right of the element
    const b = placeBubble(actor, element, bubble, VP);
    assert.equal(b.side, 'right');
    assert.equal(b.overlap, 0);
    assert.ok(b.box.x >= actor.x + actor.w);
    assert.equal(overlapArea(b.box, element), 0);
  });

  it('goes above or below when there is no room on the away side', () => {
    const element: Box = { x: 700, y: 300, w: 440, h: 100 };
    const actor = placeBeside(element, CLIPA, VP).box; // x = 1154: only 26 px to the right edge
    const b = placeBubble(actor, element, bubble, VP);
    assert.notEqual(b.side, 'right');
    assert.equal(b.overlap, 0);
    assert.ok(insideViewport(b.box, VP, MARGIN));
    assert.equal(overlapArea(b.box, element), 0);
    assert.equal(overlapArea(b.box, actor), 0);
  });

  it('without a target it prefers above the docked Clipa', () => {
    const docked = boxAt(dockCenter('bottom-right', VP, CLIPA, 0.7, MARGIN), { w: CLIPA.w * 0.7, h: CLIPA.h * 0.7 });
    const b = placeBubble(docked, null, bubble, VP);
    assert.equal(b.side, 'top');
    assert.ok(insideViewport(b.box, VP, MARGIN));
    assert.equal(overlapArea(b.box, docked), 0);
  });

  it('orders the sides away from the element first and toward it last', () => {
    const element: Box = { x: 500, y: 300, w: 100, h: 100 };
    const right: Box = { x: 700, y: 330, w: 80, h: 100 };
    assert.deepEqual(sidesAwayFrom(right, element), ['right', 'bottom', 'top', 'left']);
    const above: Box = { x: 520, y: 100, w: 80, h: 100 };
    assert.deepEqual(sidesAwayFrom(above, element), ['top', 'right', 'left', 'bottom']);
  });

  it('never covers the element or Clipa and stays in the viewport, for 2000 random elements', () => {
    const r = rng(11);
    for (let i = 0; i < 2000; i++) {
      const w = between(r, 40, 380);
      const h = between(r, 20, 260);
      const element: Box = { x: between(r, 0, VP.w - w), y: between(r, 0, VP.h - h), w, h };
      const size: Size = { w: between(r, 120, 264), h: between(r, 36, 100) };
      const actor = placeBeside(element, CLIPA, VP, { reserve: { w: 264, h: 100 } }).box;
      const b = placeBubble(actor, element, size, VP);
      assert.equal(b.overlap, 0, `${JSON.stringify({ element, actor, size })} -> ${JSON.stringify(b)}`);
      assert.ok(insideViewport(b.box, VP, MARGIN));
      assert.equal(overlapArea(b.box, element), 0);
      assert.equal(overlapArea(b.box, actor), 0);
    }
  });
});

describe('flight', () => {
  it('lasts 600-900 ms by distance, and the other timings are the spec ones', () => {
    assert.equal(flightDuration(0), FLIGHT_MIN_MS);
    assert.equal(flightDuration(100), FLIGHT_MIN_MS);
    assert.equal(flightDuration(1000), 800);
    assert.equal(flightDuration(5000), FLIGHT_MAX_MS);
    assert.equal(FLIGHT_MIN_MS, 600);
    assert.equal(FLIGHT_MAX_MS, 900);
    let last = 0;
    for (let d = 0; d <= 2000; d += 25) {
      const ms = flightDuration(d);
      assert.ok(ms >= last && ms >= 600 && ms <= 900);
      last = ms;
    }
    assert.equal(RETREAT_MS, 500);
    assert.equal(NOTICE_MS, 300);
  });

  it('eases in and out', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
    assert.equal(easeInOutCubic(0.5), 0.5);
    assert.ok(easeInOutCubic(0.1) < 0.1, 'slow start');
    assert.ok(easeInOutCubic(0.9) > 0.9, 'slow end');
    let last = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const e = easeInOutCubic(t);
      assert.ok(e >= last);
      last = e;
    }
    assert.equal(easeInOutCubic(-3), 0);
    assert.equal(easeInOutCubic(3), 1);
  });

  it('evaluates the bezier from start to end', () => {
    const path = { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, p3: { x: 100, y: 0 } };
    assert.deepEqual(bezierPoint(path, 0), { x: 0, y: 0 });
    assert.deepEqual(bezierPoint(path, 1), { x: 100, y: 0 });
    assert.deepEqual(bezierPoint(path, 0.5), { x: 50, y: 0 });
  });

  const half = { w: CLIPA.w / 2, h: CLIPA.h / 2 };

  it('arcs around an element that sits on the straight line, from the dock to the far side of it', () => {
    const from = dockCenter('bottom-right', VP, { w: 77, h: 96 }, 0.7, MARGIN);
    const obstacle: Box = { x: 700, y: 440, w: 300, h: 120 };
    const to = { x: 500, y: 380 };
    const straight = { p0: from, p1: from, p2: to, p3: to };
    assert.ok(pathViolations(straight, { obstacles: [obstacle], half }) > 0, 'the straight line would cross it');
    const options = { obstacles: [obstacle], half, scaleFrom: 0.7, scaleTo: 1, viewport: VP };
    const path = planFlightPath(from, to, options);
    assert.deepEqual(path.p0, from);
    assert.deepEqual(path.p3, to);
    assert.equal(pathViolations(path, options), 0);
  });

  it('bows upward by default and stays inside the viewport', () => {
    const from = { x: 1100, y: 700 };
    const to = { x: 300, y: 300 };
    const path = planFlightPath(from, to, { half, viewport: VP });
    const mid = bezierPoint(path, 0.5);
    const chordMid = { x: 700, y: 500 };
    assert.ok(mid.y < chordMid.y, 'arc is above the chord');
    assert.equal(pathViolations(path, { half, viewport: VP }), 0);
  });

  it('avoids both the element she leaves and the one she goes to', () => {
    const leaving: Box = { x: 600, y: 300, w: 200, h: 80 };
    const arriving: Box = { x: 600, y: 560, w: 200, h: 80 };
    const from = { x: 880, y: 340 }; // right of the first
    const to = { x: 880, y: 600 }; // right of the second
    const path = planFlightPath(from, to, { obstacles: [leaving, arriving], half, viewport: VP });
    assert.equal(pathViolations(path, { obstacles: [leaving, arriving], half, viewport: VP }), 0);
  });

  it('is clean for random small elements anywhere between the two ends', () => {
    const r = rng(23);
    let checked = 0;
    for (let i = 0; i < 600; i++) {
      const from = { x: between(r, 100, 1180), y: between(r, 100, 700) };
      const to = { x: between(r, 100, 1180), y: between(r, 100, 700) };
      if (Math.hypot(to.x - from.x, to.y - from.y) < 200) continue;
      const w = between(r, 40, 220);
      const h = between(r, 30, 140);
      const obstacle: Box = { x: between(r, 0, VP.w - w), y: between(r, 0, VP.h - h), w, h };
      // The ends are beside elements, never on them.
      if (overlaps(boxAt(from, CLIPA), inflate(obstacle, 20)) || overlaps(boxAt(to, CLIPA), inflate(obstacle, 20))) continue;
      const path = planFlightPath(from, to, { obstacles: [obstacle], half });
      assert.equal(pathViolations(path, { obstacles: [obstacle], half }), 0, JSON.stringify({ from, to, obstacle }));
      checked++;
    }
    assert.ok(checked > 200, `only ${checked} cases were usable`);
  });

  it('handles a zero-length flight', () => {
    const p = { x: 100, y: 100 };
    const path = planFlightPath(p, p, { half });
    assert.deepEqual(bezierPoint(path, 0.5), p);
  });
});

describe('docking and directions', () => {
  it('places the dock box in each corner with the margin, scaled', () => {
    const size = { w: 77, h: 96 };
    const br = dockCenter('bottom-right', VP, size, 0.7, MARGIN);
    assert.deepEqual(br, { x: 1280 - 12 - (77 * 0.7) / 2, y: 800 - 12 - (96 * 0.7) / 2 });
    const tl = dockCenter('top-left', VP, size, 1, MARGIN);
    assert.deepEqual(tl, { x: 12 + 77 / 2, y: 12 + 96 / 2 });
    assert.equal(dockCenter('bottom-left', VP, size, 1, MARGIN).x, tl.x);
    assert.equal(dockCenter('top-right', VP, size, 1, MARGIN).y, tl.y);
  });

  it('turns the eyes along a unit vector', () => {
    assert.deepEqual(lookVector({ x: 0, y: 0 }, { x: 0, y: 0 }), { x: 0, y: 0 });
    const v = lookVector({ x: 0, y: 0 }, { x: 30, y: -40 });
    assert.ok(Math.abs(v.x - 0.6) < 1e-9 && Math.abs(v.y + 0.8) < 1e-9);
  });

  it('picks one of the six arm poses toward the target', () => {
    const at = { x: 500, y: 500 };
    assert.equal(pointDirection(at, { x: 100, y: 500 }), 'left');
    assert.equal(pointDirection(at, { x: 100, y: 300 }), 'up-left');
    assert.equal(pointDirection(at, { x: 100, y: 700 }), 'down-left');
    assert.equal(pointDirection(at, { x: 900, y: 500 }), 'right');
    assert.equal(pointDirection(at, { x: 900, y: 300 }), 'up-right');
    assert.equal(pointDirection(at, { x: 900, y: 700 }), 'down-right');
  });
});
