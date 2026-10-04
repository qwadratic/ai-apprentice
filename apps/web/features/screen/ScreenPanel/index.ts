import type { CaptureSession, CaptureSnapshot, ScreenCapture } from '../../../../../packages/screen/capture/ScreenCapture.js';
import type { PrivacyMask } from '../../../../../packages/screen/privacy/masks.js';

export interface ScreenPanelOptions {
  readonly capture: ScreenCapture;
  /** Supplied by the session owner; never derive an independent epoch here. */
  readonly session: () => CaptureSession;
  /** Route lifecycle through the canonical bridge when the app shell mounts it. */
  readonly controller?: ScreenPanelController;
}

export interface ScreenPanelController {
  start(session: CaptureSession): void | Promise<void>;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** A dependency-free DOM adapter that can be mounted inside the host's React effect. */
export function mountScreenPanel(root: HTMLElement, options: ScreenPanelOptions): () => void {
  const { capture } = options;
  const controller: ScreenPanelController = options.controller ?? {
    start: (session) => capture.start(session),
    pause: () => capture.pause(),
    resume: () => { capture.resume(); },
    stop: () => capture.stop(),
  };
  const panel = document.createElement('section');
  panel.className = 'screen-panel';
  panel.setAttribute('aria-label', 'Screen sharing and privacy');
  panel.innerHTML = `
    <style>
      .screen-panel { font: inherit; color: inherit; display: grid; gap: 12px; }
      .screen-panel__controls, .screen-panel__coordinates { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .screen-panel button { font: inherit; padding: 8px 12px; cursor: pointer; }
      .screen-panel button:disabled { cursor: default; }
      .screen-panel__preview { position: relative; max-width: 960px; background: #111; }
      .screen-panel canvas { display: block; width: 100%; height: auto; touch-action: none; cursor: crosshair; }
      .screen-panel__selection { position: absolute; box-sizing: border-box; border: 2px dashed #00c6a2; pointer-events: none; }
      .screen-panel__coordinates input { width: 65px; font: inherit; }
      .screen-panel ul { margin: 0; padding-left: 24px; }
      .screen-panel p { margin: 0; }
    </style>
    <h2>Screen sharing</h2>
    <div class="screen-panel__controls">
      <button type="button" data-action="start">Choose screen or window</button>
      <button type="button" data-action="pause">Pause</button>
      <button type="button" data-action="resume">Resume</button>
      <button type="button" data-action="stop">Stop</button>
      <button type="button" data-action="edit">Review masks</button>
      <button type="button" data-action="confirm">Confirm masks and share</button>
    </div>
    <p role="status" aria-live="polite" data-status></p>
    <div class="screen-panel__preview"><div class="screen-panel__selection" hidden></div></div>
    <p>Drag over the preview to hide an area, or enter its position below. Masks stay fixed in the image: moving text may leave them. Check them whenever content moves.</p>
    <div class="screen-panel__coordinates">
      <label>Left (%) <input data-coordinate="x" type="number" min="0" max="99" step="0.1" value="0"></label>
      <label>Top (%) <input data-coordinate="y" type="number" min="0" max="99" step="0.1" value="0"></label>
      <label>Width (%) <input data-coordinate="width" type="number" min="0.1" max="100" step="0.1" value="20"></label>
      <label>Height (%) <input data-coordinate="height" type="number" min="0.1" max="100" step="0.1" value="10"></label>
      <button type="button" data-action="add">Add mask</button>
    </div>
    <ul aria-label="Privacy masks" data-masks></ul>
    <p role="alert" data-error></p>`;
  root.append(panel);
  const button = (action: string) => panel.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
  const status = panel.querySelector<HTMLElement>('[data-status]')!;
  const error = panel.querySelector<HTMLElement>('[data-error]')!;
  const preview = panel.querySelector<HTMLElement>('.screen-panel__preview')!;
  const selection = panel.querySelector<HTMLElement>('.screen-panel__selection')!;
  const maskList = panel.querySelector<HTMLElement>('[data-masks]')!;
  capture.canvas.setAttribute('aria-label', 'Processed screen preview');
  preview.prepend(capture.canvas);
  let snapshot: CaptureSnapshot = capture.getSnapshot();
  let counter = 0;
  let drag: { x: number; y: number; revision: number; pointerId: number } | null = null;
  const cleanup: Array<() => void> = [];

  function listen<T extends EventTarget>(target: T, event: string, handler: EventListener) {
    target.addEventListener(event, handler);
    cleanup.push(() => target.removeEventListener(event, handler));
  }
  function run(action: () => void | Promise<void>) {
    error.textContent = '';
    try {
      // Invoke synchronously so start() preserves the getDisplayMedia user gesture.
      const result = action();
      void Promise.resolve(result).catch(() => {
        error.textContent = 'Unable to apply this change. Check the mask coordinates and capture state.';
      });
    } catch {
      error.textContent = 'Unable to apply this change. Check the mask coordinates and capture state.';
    }
  }
  function addMask(rect: Omit<PrivacyMask, 'id'>) {
    let id: string;
    do { id = `manual-mask-${++counter}`; } while (snapshot.masks.some((mask) => mask.id === id));
    capture.setMasks([...snapshot.masks, { id, ...rect }]);
  }
  function position(event: PointerEvent) {
    const rect = capture.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }
  function rectangle(a: { x: number; y: number }, b: { x: number; y: number }) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }
  function clearDrag() {
    if (drag && capture.canvas.hasPointerCapture(drag.pointerId)) capture.canvas.releasePointerCapture(drag.pointerId);
    drag = null;
    selection.hidden = true;
  }

  cleanup.push(capture.subscribe((next) => {
    snapshot = next;
    if (drag && (next.geometry?.revision !== drag.revision || next.state !== 'paused')) clearDrag();
    button('start').disabled = !['idle', 'stopped', 'error'].includes(next.state);
    button('pause').disabled = next.state !== 'capturing';
    button('resume').disabled = next.state !== 'paused' || next.reviewRequired || next.reason === 'source-muted';
    button('stop').disabled = ['idle', 'stopped'].includes(next.state);
    button('edit').disabled = !next.geometry || !['capturing', 'paused'].includes(next.state);
    button('confirm').disabled = next.state !== 'paused' || !next.geometry || next.reason === 'source-muted';
    button('add').disabled = !next.geometry || !['capturing', 'paused'].includes(next.state);
    capture.canvas.hidden = !next.geometry;
    const errors: Partial<Record<NonNullable<CaptureSnapshot['reason']>, string>> = {
      'permission-denied': 'Screen sharing was denied or cancelled. Choose a source to try again.',
      unsupported: 'Screen sharing is unavailable. Use a supported browser over HTTPS or localhost.',
      'capture-failed': 'Could not start screen sharing. Check browser and operating system permissions.',
      'frame-failed': 'Processing failed. Sharing has stopped; choose a source to try again.',
      'consumer-failed': 'The frame consumer failed. Sharing has stopped; choose a source to try again.',
    };
    status.textContent = next.state === 'capturing' ? 'Sharing processed frames. Masks are applied before delivery.' :
      next.state === 'selecting' ? 'Choose a source in the browser picker. Nothing is being shared yet.' :
      next.state === 'error' ? errors[next.reason!] ?? 'Screen sharing failed.' :
      next.reason === 'geometry-changed' ? 'Source size changed. Sharing is paused. Check every mask and confirm again.' :
      next.reason === 'source-muted' ? 'The source is temporarily unavailable. Sharing is paused; resume when it returns.' :
      next.state === 'paused' && next.reviewRequired ? 'Local preview only. Check masks, then confirm to share.' :
      next.state === 'paused' ? 'Sharing is paused. No new frames are delivered.' :
      next.reason === 'source-ended' ? 'The selected source ended. Choose a source to start again.' : 'Screen sharing is stopped.';
    maskList.textContent = '';
    for (const mask of next.masks) {
      const row = document.createElement('li');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = `Remove ${mask.id}`;
      remove.disabled = !next.geometry;
      remove.onclick = () => run(() => capture.setMasks(snapshot.masks.filter((item) => item.id !== mask.id)));
      row.append(`${mask.id}: ${Math.round(mask.width * 100)}% × ${Math.round(mask.height * 100)}% `, remove);
      maskList.append(row);
    }
  }));

  listen(button('start'), 'click', () => {
    // This must stay in the trusted click handler, before any awaited operation.
    run(() => controller.start(options.session()));
  });
  listen(button('pause'), 'click', () => run(() => controller.pause()));
  listen(button('resume'), 'click', () => run(() => controller.resume()));
  listen(button('stop'), 'click', () => run(() => controller.stop()));
  listen(button('edit'), 'click', () => run(() => capture.beginMaskReview()));
  listen(button('confirm'), 'click', () => run(() => {
    const revision = snapshot.geometry?.revision;
    if (revision === undefined || !capture.confirmMasks(revision)) {
      error.textContent = 'The source changed or is unavailable. Check masks again before sharing.';
      return;
    }
    return controller.resume();
  }));
  listen(button('add'), 'click', () => run(() => {
    const value = (key: string) => Number(panel.querySelector<HTMLInputElement>(`[data-coordinate="${key}"]`)!.value) / 100;
    addMask({ x: value('x'), y: value('y'), width: value('width'), height: value('height') });
  }));
  listen(capture.canvas, 'pointerdown', ((event: PointerEvent) => run(() => {
    if (event.button !== 0 || !snapshot.geometry) return;
    capture.beginMaskReview();
    drag = { ...position(event), revision: snapshot.geometry!.revision, pointerId: event.pointerId };
    capture.canvas.setPointerCapture(event.pointerId);
  })) as EventListener);
  listen(capture.canvas, 'pointermove', ((event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = rectangle(drag, position(event));
    Object.assign(selection.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
    selection.hidden = false;
  }) as EventListener);
  listen(capture.canvas, 'pointerup', ((event: PointerEvent) => run(() => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = rectangle(drag, position(event));
    const valid = snapshot.geometry?.revision === drag.revision;
    clearDrag();
    if (valid && rect.width > 0 && rect.height > 0) addMask(rect);
  })) as EventListener);
  listen(capture.canvas, 'pointercancel', clearDrag);
  listen(capture.canvas, 'lostpointercapture', clearDrag);

  return () => {
    clearDrag();
    cleanup.forEach((unsubscribe) => unsubscribe());
    // Unmount is a privacy boundary: close local capture synchronously even if
    // an external transport controller throws, rejects, or never settles.
    capture.stop();
    if (options.controller) {
      try { void Promise.resolve(controller.stop()).catch(() => {}); } catch { /* Local capture is already closed. */ }
    }
    capture.canvas.remove();
    panel.remove();
  };
}
