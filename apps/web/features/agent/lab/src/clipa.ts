/*
 * Clipa, the AI Apprentice mascot, as a dependency-free web component.
 *
 *   <script src="clipa.js"></script>
 *   <clipa-buddy state="speaking" size="72"></clipa-buddy>
 *
 * Attributes (each is also a property, so React can set either):
 *   state  idle (default) | listening | thinking | speaking | warning | happy | pointing
 *   size   rendered height: a number in CSS px or any CSS length. Default: --clipa-size, else 96px.
 *          The width is 0.8 x the height. Motion, rings and the warning badge may paint slightly outside.
 *   point  where "pointing" points: up-left (default) | left | down-left | up-right | right | down-right
 *   off    boolean, "off the record": grey, eyes closed, wins over state
 *
 * The only global this file adds is the custom element <clipa-buddy>. No external requests.
 * prefers-reduced-motion: every pose stays, loops and transitions stop.
 *
 * The geometry is mirrored in mac/Sources/Apprentice/BuddyView.swift (ClipaShapes); keep them in sync.
 */
(() => {
  'use strict';
  const TAG = 'clipa-buddy';
  if (typeof window === 'undefined' || !window.customElements || window.customElements.get(TAG)) return;

  const STATES = ['idle', 'listening', 'thinking', 'speaking', 'warning', 'happy', 'pointing'];
  const POINTS = ['up-left', 'left', 'down-left', 'up-right', 'right', 'down-right'];

  // SVG user units, viewBox "12 4 96 120". One chunky wire 12 units thick: a round head loop
  // (centre 60,48, radius 30), a smaller bend nested at the bottom right (centre 78,98, radius 12)
  // and two soft ends. The lower 42 units of the left leg are a separate arm that pivots at the
  // "shoulder" (30,60); its slightly bulbous end reads as a hand when the arm is raised.
  const BODY = 'M66 84V98A12 12 0 0 0 90 98V48A30 30 0 0 0 30 48V60';
  const ARM = 'M0 0V42';
  const INK = '#0f2d2a';

  // One paint layer of the wire. Layers are stacked outline, body, shade, highlight, so the arm's
  // joint never shows a seam. `bulb` is the radius of the soft ends in this layer (0: none).
  const wire = (cls: string, color: string, width: number, dx: number, dy: number, bulb: number): string => {
    const end = (x: number, y: number): string => (bulb ? `<circle cx="${x}" cy="${y}" r="${bulb}" fill="currentColor" stroke="none"/>` : '');
    return `
      <g class="${cls}" color="${color}" transform="translate(${dx} ${dy})" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">
        <path d="${BODY}"/>
        <g transform="translate(30 60)"><g class="arm"><g class="wave"><path d="${ARM}"/>${end(0, 42)}</g></g></g>
      </g>`;
  };

  const eye = (x: number): string => `
          <g transform="translate(${x} 47)">
            <g class="blink"><circle class="eye-dot" r="4.3" fill="${INK}"/><circle class="glint" cx="1.4" cy="-1.5" r="1.25" fill="#ffffff" opacity="0"/></g>
            <path class="eye-arc" d="M-4.6 1.9Q0-3.7 4.6 1.9" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round" opacity="0"/>
            <path class="eye-shut" d="M-4.4 0.2Q0 3 4.4 0.2" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" opacity="0"/>
          </g>`;

  const MARKUP = `
<div class="root" data-s="idle" data-p="up-left">
  <svg class="fx" viewBox="12 4 96 120" aria-hidden="true" focusable="false">
    <g transform="translate(60 118)"><g class="pose"><g transform="translate(0 -54)">
      <g class="ring r1"><circle r="44" fill="none" stroke="#17b3a3" stroke-width="2.4"/></g>
      <g class="ring r2"><circle r="44" fill="none" stroke="#17b3a3" stroke-width="2.4"/></g>
    </g></g></g>
  </svg>
  <svg class="char" viewBox="12 4 96 120" aria-hidden="true" focusable="false">
    <g transform="translate(60 118)"><g class="pose"><g class="motion"><g transform="translate(-60 -118)">
      <g transform="translate(60 0)"><g class="flip"><g transform="translate(-60 0)">
        <circle class="plate" cx="60" cy="48" r="25" fill="#f1fbf9"/>
        ${wire('w-line', '#0b5d56', 15.6, 0, 0, 9)}
        ${wire('w-body', '#17b3a3', 12, 0, 0, 7.2)}
        ${wire('w-shade', '#0f9585', 5, 1.6, 1.8, 0)}
        ${wire('w-hi', '#a3f2e7', 2.8, -2.2, -2.2, 0)}
        <g class="face">
          <g class="cheeks" fill="#ff8a73" opacity=".3"><ellipse cx="43.5" cy="57" rx="4.2" ry="2.5"/><ellipse cx="76.5" cy="57" rx="4.2" ry="2.5"/></g>
          <g class="look">${eye(49.5)}${eye(70.5)}
          </g>
          <g transform="translate(60 59.5)">
            <path class="m m-smile" d="M-5.2-1.4Q0 3.8 5.2-1.4" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>
            <g class="m m-talk" opacity="0"><g class="talk"><ellipse rx="4.2" ry="3.7" fill="${INK}"/></g></g>
            <path class="m m-hmm" d="M-3.6 0.9Q0-0.5 3.8 0.3" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" opacity="0"/>
            <path class="m m-flat" d="M-4.2 0.4H4.2" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round" opacity="0"/>
            <path class="m m-grin" d="M-6-2.2Q0 7.2 6-2.2Z" fill="${INK}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round" opacity="0"/>
          </g>
        </g>
      </g></g></g>
    </g></g></g></g>
    <g class="dots" fill="#17b3a3" stroke="#0b5d56" stroke-width="1.4">
      <circle cx="88" cy="26" r="2.4" opacity="0"/><circle cx="95.5" cy="17" r="3.1" opacity="0"/><circle cx="104" cy="7.5" r="3.8" opacity="0"/>
    </g>
    <g class="badge" transform="translate(95 21)"><g class="pop">
      <circle r="9.5" fill="#f5a524" stroke="#8f5200" stroke-width="2"/>
      <rect x="-1.7" y="-5.7" width="3.4" height="7.3" rx="1.7" fill="#3a2400"/>
      <circle cy="4.7" r="1.9" fill="#3a2400"/>
    </g></g>
  </svg>
</div>`;

  const CSS = `
:host { display: inline-block; vertical-align: middle; line-height: 0; }
:host([hidden]) { display: none; }
.root { --s: var(--clipa-size, 96px); display: grid; width: calc(var(--s) * 0.8); height: var(--s); }
.root > svg { grid-area: 1 / 1; width: 100%; height: 100%; overflow: visible; }
.w-hi { opacity: 0.8; }
.char { filter: drop-shadow(0 1px 1px rgba(3, 32, 29, 0.3)) drop-shadow(0 3px 6px rgba(3, 32, 29, 0.2)); }
g, path, circle, ellipse, rect { transform-box: view-box; transform-origin: 0 0; }

/* Poses: transitions between states. */
.pose { transform: rotate(var(--lean, 0deg)) scale(var(--grow, 1)); transition: transform 0.5s cubic-bezier(0.3, 1.4, 0.5, 1); }
.flip { transform: scaleX(var(--flip, 1)); transition: transform 0.35s ease-in-out; }
.arm { transform: rotate(var(--arm, 0deg)); transition: transform 0.45s cubic-bezier(0.3, 1.45, 0.5, 1); }
.look { transform: translate(var(--lx, 0px), var(--ly, 0px)); transition: transform 0.3s ease; }
.eye-dot { transform: scale(var(--eye, 1)); transition: transform 0.3s ease; }
.m, .blink, .eye-arc, .eye-shut, .glint, .cheeks { transition: opacity 0.18s ease; }
.badge .pop { transform: scale(0); transition: transform 0.35s cubic-bezier(0.3, 1.6, 0.5, 1); }
.ring, .dots circle { opacity: 0; }
.talk { transform: scaleY(0.35); }

[data-s="listening"] { --lean: -5deg; --grow: 1.04; --eye: 1.12; --lx: -0.8px; --ly: -0.5px; }
[data-s="thinking"] { --lx: 2.3px; --ly: -2.8px; }
[data-s="warning"] { --lean: 5deg; --arm: 162deg; --eye: 1.1; }
[data-s="pointing"] { --arm: 122deg; --lean: -4deg; --lx: -2.3px; --ly: -1.6px; }
[data-s="pointing"][data-p="left"] { --arm: 96deg; --ly: 0px; }
[data-s="pointing"][data-p="down-left"] { --arm: 62deg; --lean: -2deg; --ly: 1.6px; }
[data-s="pointing"][data-p$="right"] { --flip: -1; --lean: 4deg; }
[data-s="pointing"][data-p="right"] { --arm: 96deg; --ly: 0px; }
[data-s="pointing"][data-p="down-right"] { --arm: 62deg; --lean: 2deg; --ly: 1.6px; }

/* Faces. */
.m { opacity: 0; }
[data-s="idle"] .m-smile, [data-s="listening"] .m-smile, [data-s="pointing"] .m-smile, [data-s="off"] .m-smile { opacity: 1; }
[data-s="speaking"] .m-talk { opacity: 1; }
[data-s="thinking"] .m-hmm { opacity: 1; }
[data-s="warning"] .m-flat { opacity: 1; }
[data-s="happy"] .m-grin { opacity: 1; }
[data-s="listening"] .glint { opacity: 1; }
[data-s="happy"] .blink, [data-s="off"] .blink { opacity: 0; }
[data-s="happy"] .eye-arc { opacity: 1; }
[data-s="off"] .eye-shut { opacity: 1; }
[data-s="happy"] .cheeks { opacity: 0.5; }
[data-s="warning"] .badge .pop { transform: scale(1); }
[data-s="warning"] .ring circle { stroke: #f5a524; stroke-width: 3; }
[data-s="warning"] .r2 { opacity: 0.6; }

/* Off the record: grey and asleep. */
[data-s="off"] .w-line { color: #66716f; }
[data-s="off"] .w-body { color: #a9b4b2; }
[data-s="off"] .w-shade { color: #909b99; }
[data-s="off"] .w-hi { color: #e0e7e6; }
[data-s="off"] .plate { fill: #eef2f1; }
[data-s="off"] .eye-shut, [data-s="off"] .m-smile { stroke: #48524f; }
[data-s="off"] .cheeks { opacity: 0; }

/* Loops. */
.motion { animation: clipa-breathe 4.2s ease-in-out infinite; }
.blink { animation: clipa-blink 6.4s linear infinite; }
[data-s="speaking"] .motion { animation: clipa-bounce 0.86s ease-in-out infinite; }
[data-s="speaking"] .talk { animation: clipa-talk 0.9s linear infinite; }
[data-s="thinking"] .motion { animation: clipa-wiggle 1.9s ease-in-out infinite; }
[data-s="thinking"] .dots circle { animation: clipa-dot 1.5s ease-in-out infinite; }
[data-s="thinking"] .dots circle:nth-child(2) { animation-delay: 0.2s; }
[data-s="thinking"] .dots circle:nth-child(3) { animation-delay: 0.4s; }
[data-s="listening"] .motion { animation: clipa-nod 2.4s ease-in-out infinite; }
[data-s="listening"] .ring { animation: clipa-ring 1.8s ease-out infinite; }
[data-s="listening"] .r2 { animation-delay: 0.9s; }
[data-s="warning"] .motion { animation: clipa-brace 0.5s ease-out 1; }
[data-s="warning"] .wave { animation: clipa-wave 1.3s ease-in-out infinite; }
[data-s="warning"] .r1 { animation: clipa-ring 2.4s ease-out infinite; }
[data-s="happy"] .motion { animation: clipa-hop 1.7s cubic-bezier(0.3, 0.7, 0.4, 1) infinite; }
[data-s="pointing"] .wave { animation: clipa-tap 1.3s ease-in-out infinite; }
[data-s="off"] .motion { animation-duration: 6s; }
[data-s="off"] .blink { animation: none; }

@keyframes clipa-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(0.992, 1.022); } }
@keyframes clipa-blink {
  0%, 46%, 49.5%, 90%, 93.5%, 96%, 99%, 100% { transform: scaleY(1); }
  47.8%, 91.8%, 97.5% { transform: scaleY(0.1); }
}
@keyframes clipa-bounce {
  0%, 100% { transform: translateY(0) scale(1, 1); }
  35% { transform: translateY(-3.2px) scale(0.99, 1.015); }
  70% { transform: translateY(0) scale(1.012, 0.988); }
}
@keyframes clipa-talk {
  0%, 100% { transform: scaleY(0.3); } 18% { transform: scaleY(1); } 32% { transform: scaleY(0.5); }
  48% { transform: scaleY(0.9); } 62% { transform: scaleY(0.25); } 78% { transform: scaleY(0.8); }
}
@keyframes clipa-wiggle { 0%, 100% { transform: rotate(-2.2deg); } 50% { transform: rotate(2.6deg); } }
@keyframes clipa-dot { 0%, 100% { opacity: 0.45; } 45% { opacity: 1; } }
@keyframes clipa-nod { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-1.6deg) translateY(-0.6px); } }
@keyframes clipa-ring { 0% { transform: scale(0.82); opacity: 0.75; } 100% { transform: scale(1.18); opacity: 0; } }
@keyframes clipa-brace { 0% { transform: none; } 35% { transform: translateY(1.5px) scale(1.03, 0.96); } 100% { transform: none; } }
@keyframes clipa-wave { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-12deg); } }
@keyframes clipa-tap { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(7deg); } }
@keyframes clipa-hop {
  0% { transform: translateY(0) scale(1, 1); }
  10% { transform: translateY(0) scale(1.08, 0.9); }
  26% { transform: translateY(-13px) scale(0.95, 1.06); }
  36% { transform: translateY(-15px) scale(1, 1); }
  50% { transform: translateY(0) scale(1.07, 0.92); }
  60% { transform: translateY(0) scale(0.98, 1.02); }
  68%, 100% { transform: translateY(0) scale(1, 1); }
}

@media (prefers-reduced-motion: reduce) {
  .motion, .blink, .wave, .talk, .ring, .dots circle { animation: none !important; }
  .pose, .flip, .arm, .look, .eye-dot, .badge .pop { transition: none !important; }
  [data-s="speaking"] .talk { transform: scaleY(0.75); }
  [data-s="thinking"] .dots circle { opacity: 1; }
  [data-s="listening"] .r1, [data-s="warning"] .r1 { opacity: 0.5; transform: scale(1.02); }
}`;

  const isOn = (value: string | null): boolean => value !== null && value !== 'false';

  class ClipaBuddy extends HTMLElement {
    static get observedAttributes(): string[] { return ['state', 'size', 'point', 'off']; }

    private _root: HTMLElement;
    private _label: string | null;

    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>${CSS}</style>${MARKUP}`;
      const root = shadow.querySelector<HTMLElement>('.root');
      if (!root) throw new Error('clipa-buddy: markup has no .root element');
      this._root = root;
      this._label = null;
    }

    connectedCallback(): void {
      if (!this.hasAttribute('role')) this.setAttribute('role', 'img');
      this._render();
    }

    attributeChangedCallback(): void { this._render(); }

    get state(): string { return this.getAttribute('state') || 'idle'; }
    set state(value: unknown) { this.setAttribute('state', String(value)); }
    get size(): string | null { return this.getAttribute('size'); }
    set size(value: unknown) { if (value === null || value === undefined || value === '') this.removeAttribute('size'); else this.setAttribute('size', String(value)); }
    get point(): string { return this.getAttribute('point') || 'up-left'; }
    set point(value: unknown) { this.setAttribute('point', String(value)); }
    get off(): boolean { return isOn(this.getAttribute('off')); }
    set off(value: unknown) { if (value) this.setAttribute('off', ''); else this.removeAttribute('off'); }

    private _render(): void {
      const root = this._root;
      const raw = this.getAttribute('state');
      const state = raw !== null && STATES.includes(raw) ? raw : 'idle';
      const off = isOn(this.getAttribute('off'));
      root.dataset.s = off ? 'off' : state;
      const point = this.getAttribute('point');
      root.dataset.p = point !== null && POINTS.includes(point) ? point : 'up-left';

      const size = (this.getAttribute('size') || '').trim();
      if (size) root.style.setProperty('--s', /^\d+(\.\d+)?$/.test(size) ? `${size}px` : size);
      else root.style.removeProperty('--s');

      // Keep an accessible name unless the page set its own.
      if (this.isConnected && (!this.hasAttribute('aria-label') || this.getAttribute('aria-label') === this._label)) {
        this._label = `Clipa, ${off ? 'off the record' : state}`;
        this.setAttribute('aria-label', this._label);
      }
    }
  }

  window.customElements.define(TAG, ClipaBuddy);
})();
