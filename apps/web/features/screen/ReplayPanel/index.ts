import type {EvidenceRef} from '@apprentice/contracts';
import {EvidenceTimeline, type RecordingSegment} from '../../../../../packages/screen/evidence/index.js';

export interface ReplayPanelOptions {
  readonly resolveEvidence: (evidenceId: string, options?: {signal?: AbortSignal}) => Promise<EvidenceRef>;
  readonly recordingSegments: () => readonly RecordingSegment[] | Promise<readonly RecordingSegment[]>;
  readonly resolveRecordingAsset: (segment: RecordingSegment, options?: {signal?: AbortSignal}) => string | Blob | Promise<string | Blob>;
  readonly sessionId?: string;
  /** Bounds resolver, metadata and seek work. Defaults to 10 seconds. */
  readonly loadTimeoutMs?: number;
  /** Maximum accepted seek clamp/rounding difference. Defaults to 150 ms. */
  readonly seekToleranceMs?: number;
}

export interface ReplayPanelHandle {
  openEvidence(evidenceId: string, sessionTimestampMs?: number): Promise<void>;
  dispose(): void;
}

/** Dependency-free DOM adapter intended for mounting from the app shell's React effect. */
export function mountReplayPanel(root: HTMLElement, options: ReplayPanelOptions): ReplayPanelHandle {
  const panel = document.createElement('section');
  panel.className = 'replay-panel';
  panel.setAttribute('aria-label', 'Screen evidence replay');
  panel.innerHTML = `
    <style>
      .replay-panel { display: grid; gap: 10px; font: inherit; color: inherit; }
      .replay-panel__stage { min-height: 120px; display: grid; place-items: center; background: #111; border-radius: 10px; overflow: hidden; }
      .replay-panel video, .replay-panel img { display: block; width: 100%; max-height: 520px; object-fit: contain; }
      .replay-panel p { margin: 0; }
    </style>
    <h2>Screen evidence</h2>
    <p role="status" aria-live="polite" data-status>No evidence selected.</p>
    <div class="replay-panel__stage" data-stage></div>`;
  root.append(panel);
  const status = panel.querySelector<HTMLElement>('[data-status]')!;
  const stage = panel.querySelector<HTMLElement>('[data-stage]')!;
  let generation = 0;
  let activeAbort: AbortController | undefined;
  let disposed = false;
  let ownedObjectUrl: string | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;

  function clear(): void {
    const media = stage.querySelector<HTMLMediaElement>('video');
    if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
    stage.replaceChildren();
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
    if (ownedObjectUrl) { URL.revokeObjectURL(ownedObjectUrl); ownedObjectUrl = undefined; }
  }
  function unavailable(message: string): void {
    ++generation;
    activeAbort?.abort();
    clear();
    status.textContent = message;
  }
  function current(token: number): boolean { return !disposed && token === generation; }

  async function openEvidence(evidenceId: string, requestedTimestampMs?: number): Promise<void> {
    const token = ++generation;
    activeAbort?.abort();
    const request = new AbortController();
    activeAbort = request;
    clear();
    status.textContent = 'Loading screen evidence…';
    try {
      const timeoutMs = options.loadTimeoutMs ?? 10_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Replay load timeout must be positive.');
      const cancelled = new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new DOMException('Replay request was cancelled.', 'AbortError')), {once: true});
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        activeTimer = setTimeout(() => {
          const error = new ReplayDeadlineError();
          if (current(token)) unavailable('This evidence took too long to load or seek.');
          request.abort();
          reject(error);
        }, timeoutMs);
      });
      const [evidence, segments] = await Promise.race([Promise.all([
        options.resolveEvidence(evidenceId, {signal: request.signal}),
        Promise.resolve(options.recordingSegments()),
      ]), deadline, cancelled]);
      if (!current(token)) return;
      const timestampMs = requestedTimestampMs ?? evidence.startMs;
      const target = new EvidenceTimeline(segments).forEvidence(evidence, timestampMs, options.sessionId);
      if (!target) {
        showImage(evidence.assetRef, token);
        return;
      }
      const asset = await Promise.race([
        Promise.resolve(options.resolveRecordingAsset(target.segment, {signal: request.signal})), deadline, cancelled,
      ]);
      if (!current(token)) return;
      const source = typeof asset === 'string' ? asset : URL.createObjectURL(asset);
      if (typeof asset !== 'string') ownedObjectUrl = source;
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.setAttribute('aria-label', 'Recorded screen evidence');
      video.src = source;
      const fail = () => { if (current(token)) unavailable('This recording is unavailable or could not be loaded.'); };
      video.addEventListener('error', fail, {once: true});
      video.addEventListener('loadedmetadata', () => {
        if (!current(token)) return;
        try {
          const seekSeconds = target.mediaTimestampMs / 1000;
          if (Number.isFinite(video.duration) && seekSeconds > video.duration + .05) {
            unavailable('The recording is shorter than the requested evidence moment.'); return;
          }
          video.currentTime = seekSeconds;
          status.textContent = `Seeking to ${(timestampMs / 1000).toFixed(2)} seconds…`;
        } catch { unavailable('The recording loaded, but the requested moment could not be opened.'); }
      }, {once: true});
      video.addEventListener('seeked', () => {
        if (!current(token)) return;
        const tolerance = (options.seekToleranceMs ?? 150) / 1000;
        if (!Number.isFinite(tolerance) || tolerance < 0 || Math.abs(video.currentTime - target.mediaTimestampMs / 1000) > tolerance) {
          unavailable('The recording could not open the requested evidence moment.'); return;
        }
        if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
        status.textContent = `Showing evidence at ${(timestampMs / 1000).toFixed(2)} seconds.`;
      }, {once: true});
      stage.append(video);
      video.load();
    } catch (error) {
      if (!current(token) || (request.signal.aborted && !(error instanceof ReplayDeadlineError))) return;
      unavailable(error instanceof ReplayDeadlineError ? 'This evidence took too long to load or seek.' :
        error instanceof Error && error.name === 'AbortError' ? 'Evidence loading was cancelled.' : 'This evidence is unavailable.');
    }
  }

  function showImage(assetRef: string, token: number): void {
    const image = document.createElement('img');
    image.alt = 'Processed screen evidence';
    image.addEventListener('load', () => {
      if (!current(token)) return;
      if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
      status.textContent = 'Showing processed frame evidence.';
    }, {once: true});
    image.addEventListener('error', () => { if (current(token)) unavailable('This evidence asset is unavailable or could not be loaded.'); }, {once: true});
    image.src = assetRef;
    stage.append(image);
  }

  return {
    openEvidence,
    dispose() {
      if (disposed) return;
      disposed = true; ++generation; activeAbort?.abort(); clear(); panel.remove();
    },
  };
}

class ReplayDeadlineError extends Error {}
