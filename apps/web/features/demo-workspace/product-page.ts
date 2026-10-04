import type {ScreenObservation} from '@apprentice/contracts';
import {createRuntimeWorkspace} from './index.ts';
import './workspace.css';
import './product-page.css';

const root = document.getElementById('product-workspace');
if (!root) throw new Error('Missing product workspace root.');
root.innerHTML = `
  <header class="product-header">
    <div><p class="product-kicker">AI Apprentice</p><h1>Learn from work. Check before action.</h1>
      <p class="product-subtitle">A synthetic order-to-email task with processed screen evidence and a human-controlled Send step.</p></div>
    <div class="product-session">
      <label>API base URL<input data-api autocomplete="url"></label>
      <button type="button" data-prepare>Prepare secure session</button>
      <p data-session-status role="status">Prepare a session before choosing a screen or window.</p>
    </div>
  </header>
  <section class="product-toolbar" aria-label="Privacy and runtime controls">
    <button type="button" data-off-record disabled>Go off record</button>
    <span data-runtime-status>Screen runtime is not connected.</span>
  </section>
  <details class="product-capture" open>
    <summary>Screen capture and privacy masks</summary>
    <p>Only processed frames are sent. Review masks before sharing; moving content can leave a fixed mask behind.</p>
    <div data-screen-root></div>
  </details>
  <section class="product-observations" aria-labelledby="observations-title">
    <div><p class="product-kicker">Validated runtime stream</p><h2 id="observations-title">Latest vision observations</h2></div>
    <p data-observation-empty>No vision observations yet. Start capture and show the order and email surfaces.</p>
    <div data-observations></div>
    <p class="product-policy" data-checkpoint-status>Checkpoint policy is waiting for the product agent integration. Preview will fail visibly rather than inventing a result.</p>
  </section>
  <div class="product-workspace-scroll"><div data-workspace-root></div></div>`;

const element = <T extends HTMLElement>(selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing product element: ${selector}`);
  return found;
};
const apiInput = element<HTMLInputElement>('[data-api]');
const prepareButton = element<HTMLButtonElement>('[data-prepare]');
const offRecordButton = element<HTMLButtonElement>('[data-off-record]');
const sessionStatus = element<HTMLElement>('[data-session-status]');
const runtimeStatus = element<HTMLElement>('[data-runtime-status]');
const checkpointStatus = element<HTMLElement>('[data-checkpoint-status]');
const observationList = element<HTMLElement>('[data-observations]');
const observationEmpty = element<HTMLElement>('[data-observation-empty]');
apiInput.value = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000';

let mounted: ReturnType<typeof createRuntimeWorkspace> | undefined;
let cleanup: Array<() => void> = [];
let token: string | null = null;
let offRecord = false;
const observations = new Map<ScreenObservation['kind'], ScreenObservation>();

function clearMount(): void {
  for (const dispose of cleanup.splice(0)) dispose();
  mounted?.dispose(); mounted = undefined; token = null; offRecord = false;
  observations.clear(); observationList.replaceChildren(); observationEmpty.hidden = false;
  offRecordButton.disabled = true; offRecordButton.textContent = 'Go off record';
  runtimeStatus.textContent = 'Screen runtime is not connected.';
}

function renderObservation(observation: ScreenObservation): void {
  observations.set(observation.kind, observation);
  observationEmpty.hidden = true;
  observationList.replaceChildren(...[...observations.values()].map(value => {
    const card = document.createElement('article'); card.className = 'product-observation-card';
    const title = document.createElement('h3'); title.textContent = value.kind.replaceAll('_', ' ');
    const detail = document.createElement('p');
    detail.textContent = `Sequence ${value.sequence} · revision ${value.sourceRevision ?? 'none'} · ${value.evidenceIds.length} evidence item(s)`;
    card.append(title, detail);
    for (const evidenceId of value.evidenceIds) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Open evidence ${evidenceId.slice(0, 8)}`;
      button.onclick = () => { void openEvidence(evidenceId, card, button); };
      card.append(button);
    }
    return card;
  }));
}

async function openEvidence(evidenceId: string, card: HTMLElement, button: HTMLButtonElement): Promise<void> {
  if (!mounted) return;
  button.disabled = true;
  try {
    const evidence = await mounted.bridge.resolveEvidence(evidenceId);
    const image = document.createElement('img'); image.src = evidence.assetRef; image.alt = 'Processed screen evidence';
    card.querySelector('img')?.remove(); card.append(image);
  } catch { runtimeStatus.textContent = 'Evidence is unavailable for the current session.'; }
  finally { button.disabled = false; }
}

prepareButton.onclick = async () => {
  prepareButton.disabled = true; sessionStatus.textContent = 'Preparing a server session…'; clearMount();
  const apiBase = apiInput.value.trim().replace(/\/$/, '');
  try {
    const response = await fetch(`${apiBase}/api/agent/sessions`, {method: 'POST'});
    if (!response.ok) throw new Error(`Session API returned HTTP ${response.status}.`);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('sessionId' in value) || typeof value.sessionId !== 'string' ||
      !('token' in value) || typeof value.token !== 'string') throw new Error('Session API response is invalid.');
    const sessionId = value.sessionId; token = `Bearer ${value.token}`;
    mounted = createRuntimeWorkspace({
      workspaceRoot: element('[data-workspace-root]'), screenRoot: element('[data-screen-root]'), apiBase,
      authHeader: () => token,
      // Called again by the panel in its trusted Start click; that exact instant owns the capture timeline epoch.
      session: () => ({sessionId, sessionEpochMs: Date.now()}),
    });
    cleanup.push(mounted.bridge.onStatus(status => {
      runtimeStatus.textContent = `Screen ${status.state}${status.reason ? ` · ${status.reason}` : ''}`;
      offRecordButton.disabled = status.state === 'stopped' || status.state === 'error';
    }));
    cleanup.push(mounted.bridge.onObservation(observation => {
      if (observation.source === 'vision') renderObservation(observation);
    }));
    cleanup.push(mounted.bridge.onCheckpoint(checkpoint => {
      checkpointStatus.textContent = `Waiting for the product agent to answer checkpoint ${checkpoint.id}. No decision is fabricated by this page.`;
    }));
    offRecordButton.disabled = false;
    sessionStatus.textContent = 'Session ready. Choose a screen or window, review masks, then confirm sharing.';
  } catch (error) {
    clearMount(); sessionStatus.textContent = error instanceof Error ? error.message : 'Could not prepare the session.';
  } finally { prepareButton.disabled = false; }
};

offRecordButton.onclick = async () => {
  if (!mounted) return;
  offRecordButton.disabled = true;
  try {
    offRecord = !offRecord; await mounted.setOffRecord(offRecord);
    offRecordButton.textContent = offRecord ? 'Resume recording' : 'Go off record';
    runtimeStatus.textContent = offRecord ? 'Off record · capture, activity and checks are paused.' : 'Recording resumed.';
  } catch { offRecord = !offRecord; runtimeStatus.textContent = 'Privacy state could not be changed.'; }
  finally { offRecordButton.disabled = false; }
};

window.addEventListener('pagehide', clearMount);
