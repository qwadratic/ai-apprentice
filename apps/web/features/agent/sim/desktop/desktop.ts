// The simulated desktop: a wallpaper, one window (the demo workspace goes into it) and a taskbar, with a visible mouse
// cursor the persona flies to its targets. The tab that shares its screen looks like a person's desktop, and a viewer, the
// recording and the vision model all see the same pixels. The label "Simulation — synthetic ..." is always visible: nothing
// on this page is a real person. Browser only. All CSS is scoped under .sim-desktop (desktop.css, imported by the host page).
import type { Clock } from '../clock.ts';
import type { Persona } from '../personas.ts';

export interface SimCursor {
  /** Flies the cursor to the element (scrolling it into view first) and resolves when it has arrived. */
  moveTo(target: Element): Promise<void>;
  /** A click ripple at the cursor. */
  click(): void;
  /** Where the cursor is, in viewport coordinates. */
  position(): { x: number; y: number };
}

export interface SimDesktop {
  readonly root: HTMLElement;
  /** Mount the workspace here. */
  readonly workspaceHost: HTMLElement;
  readonly cursor: SimCursor;
  setTaskbarNote(text: string): void;
  dispose(): void;
}

export interface SimDesktopOptions {
  persona: Persona;
  clock: Clock;
  /** Window title. */
  title?: string;
}

const CURSOR_SVG =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 2l15 9-6.5 1.6L9.4 19z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';

export function mountSimDesktop(container: HTMLElement, options: SimDesktopOptions): SimDesktop {
  const doc = container.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'sim-desktop';
  root.dataset['simDesktop'] = options.persona.id;
  root.innerHTML = `
    <div class="sim-banner" role="status">
      <strong data-sim="banner"></strong>
      <span>People, data and voices on this desktop are synthetic. Nothing here is a real person.</span>
    </div>
    <div class="sim-wallpaper">
      <section class="sim-window" aria-label="Order desk, synthetic workspace">
        <header class="sim-titlebar"><span class="sim-dots" aria-hidden="true"></span><span class="sim-title" data-sim="title"></span></header>
        <div class="sim-window-body" data-sim="workspace-host"></div>
      </section>
      <div class="sim-cursor" data-sim="cursor" aria-hidden="true">${CURSOR_SVG}</div>
    </div>
    <footer class="sim-taskbar">
      <span class="sim-start">Start</span>
      <span class="sim-task">Order desk</span>
      <span class="sim-note" data-sim="note"></span>
      <span class="sim-tag" data-sim="tag"></span>
      <span class="sim-clock" data-sim="clock"></span>
    </footer>`;
  container.append(root);

  const part = <T extends HTMLElement>(name: string): T => {
    const found = root.querySelector<T>(`[data-sim="${name}"]`);
    if (!found) throw new Error(`the simulated desktop is missing its ${name} part`);
    return found;
  };
  part('banner').textContent = options.persona.banner;
  part('title').textContent = options.title ?? 'Order desk — synthetic workspace';
  part('tag').textContent = options.persona.displayName.toUpperCase();
  const workspaceHost = part('workspace-host');
  const cursorEl = part('cursor');
  const noteEl = part('note');
  const clockEl = part('clock');
  const wallpaper = root.querySelector<HTMLElement>('.sim-wallpaper');
  if (!wallpaper) throw new Error('the simulated desktop has no wallpaper');

  const tick = (): void => {
    clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  const timer = window.setInterval(tick, 15_000);

  let x = 80;
  let y = 120;
  const place = (nextX: number, nextY: number, durationMs: number): void => {
    const origin = wallpaper.getBoundingClientRect();
    cursorEl.style.transitionDuration = `${durationMs}ms`;
    cursorEl.style.transform = `translate(${Math.round(nextX - origin.left)}px, ${Math.round(nextY - origin.top)}px)`;
    x = nextX;
    y = nextY;
  };
  place(x, y, 0);

  const cursor: SimCursor = {
    async moveTo(target) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const box = target.getBoundingClientRect();
      const nextX = box.left + Math.min(box.width * 0.3, 120);
      const nextY = box.top + Math.min(box.height / 2, 22);
      const distance = Math.hypot(nextX - x, nextY - y);
      const durationMs = Math.round(Math.min(1100, Math.max(260, 220 + distance * 0.9)));
      place(nextX, nextY, durationMs);
      await options.clock.sleep(durationMs);
    },
    click() {
      cursorEl.classList.remove('clicking');
      void cursorEl.offsetWidth;
      cursorEl.classList.add('clicking');
    },
    position: () => ({ x, y }),
  };
  // A click anywhere on the desktop pulses the cursor: the persona's clicks and a viewer's look the same.
  root.addEventListener('click', () => cursor.click(), true);

  return {
    root,
    workspaceHost,
    cursor,
    setTaskbarNote(text) {
      noteEl.textContent = text;
    },
    dispose() {
      window.clearInterval(timer);
      root.remove();
    },
  };
}
