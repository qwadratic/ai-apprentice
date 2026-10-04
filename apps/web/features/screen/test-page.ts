import { createScreenBridge, mountScreenPanel } from './index.ts';
import type { ScreenObservation } from '@apprentice/contracts';

const root = document.getElementById('screen-test')!;
root.innerHTML = `
<style>
body { margin: 0; background: #eef2f6; color: #172b40; font: 16px system-ui; }
#screen-test { max-width: 1200px; margin: auto; padding: 28px; }
section, .card { background: white; padding: 24px; border-radius: 16px; margin: 16px 0; }
h1 { margin-bottom: 8px; } button, input, select { font: inherit; padding: 8px; }
label { display: inline-flex; flex-direction: column; gap: 6px; margin: 0 14px 12px 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.badge { color: #005b47; font-weight: bold; } #result { border-left: 5px solid #177d63; }
#status { padding: 12px; background: #e2eaf4; } img { max-width: 100%; }
</style>
<p class="badge">REAL SCREEN → REAL VISION · INTEGRATION TEST</p>
<h1>Screen observation test</h1>
<p>Open the synthetic order, choose its window, mask the private marker, then confirm sharing. Results below come from the backend vision model. No mock observations are generated.</p>
<p><a href="./screen-fixture.html" target="_blank" rel="noopener">Open synthetic order in another tab</a></p>
<div class="card">
<label>API base URL<input id="api" value="http://127.0.0.1:8000" placeholder="API origin"></label>
<button id="prepare">Prepare session</button>
<p id="setup">Prepare a real agent session before opening the browser picker. The API must have its real vision runner configured; this page has no mock fallback.</p>
</div>
<p id="status" role="status">Not started</p>
<div id="panel"></div>
<section id="result"><h2>Latest validated ScreenObservation</h2><p id="count">No observations received.</p><pre id="observation"></pre><button id="evidence" disabled>Load processed evidence</button><div id="media"></div></section>
<section><h2>Lifecycle</h2><pre id="events"></pre></section>`;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let dispose: (() => void) | undefined;
let latest: ScreenObservation | undefined;
let count = 0;
const events: string[] = [];
function record(message: string) {
  events.unshift(`${new Date().toLocaleTimeString()} ${message}`);
  element('events').textContent = events.slice(0, 20).join('\n');
}
element<HTMLButtonElement>('prepare').onclick = async () => {
  const prepare = element<HTMLButtonElement>('prepare');
  prepare.disabled = true;
  dispose?.(); dispose = undefined;
  latest = undefined; count = 0;
  element('observation').textContent = '';
  element('count').textContent = 'No observations received.';
  element<HTMLButtonElement>('evidence').disabled = true;
  const apiBase = element<HTMLInputElement>('api').value.trim().replace(/\/$/, '');
  let token: string | null = null;
  try {
    let session: { sessionId: string; sessionEpochMs: number };
    const response = await fetch(`${apiBase}/api/agent/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(`Agent session setup returned HTTP ${response.status}.`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('sessionId' in data) || typeof data.sessionId !== 'string' || !('sessionEpochMs' in data) || typeof data.sessionEpochMs !== 'number' || !('token' in data) || typeof data.token !== 'string') throw new Error('Agent session response is invalid.');
    session = { sessionId: data.sessionId, sessionEpochMs: data.sessionEpochMs };
    token = `Bearer ${data.token}`;
    record('Real agent session prepared.');
    const runtime = createScreenBridge({ apiBase, authHeader: () => token, sourceRevision: () => null });
    const unsubscribeStatus = runtime.bridge.onStatus(status => {
      element('status').textContent = `${status.state}${status.reason ? `: ${status.reason}` : ''}`;
      record(`Screen ${status.state}${status.reason ? ` (${status.reason})` : ''}`);
    });
    const unsubscribeObservation = runtime.bridge.onObservation(observation => {
      latest = observation;
      element('observation').textContent = JSON.stringify(observation, null, 2);
      element('count').textContent = `${++count} real vision observation(s) received. Latest: ${observation.kind}.`;
      element<HTMLButtonElement>('evidence').disabled = !observation.evidenceIds.length;
      record(`Validated ${observation.kind}; ${observation.evidenceIds.length} evidence reference(s).`);
    });
    const unmount = mountScreenPanel(element('panel'), { capture: runtime.capture, session: () => session, controller: runtime.panelController });
    dispose = () => { unmount(); unsubscribeStatus(); unsubscribeObservation(); runtime.dispose(); };
    element('setup').textContent = 'Session ready. Choose the synthetic order tab or window, review the local preview, add a mask, then confirm.';
    element<HTMLButtonElement>('evidence').onclick = async () => {
      const id = latest?.evidenceIds[0]; if (!id) return;
      try {
        const reference = await runtime.bridge.resolveEvidence(id);
        // The bridge returns a browser-loadable processed asset reference.
        element('media').replaceChildren();
        const img = document.createElement('img'); img.alt = 'Processed evidence saved by the backend'; img.src = reference.assetRef;
        element('media').append(img);
      } catch { record('Evidence could not be resolved.'); }
    };
  } catch (error) {
    element('setup').textContent = error instanceof Error ? error.message : 'Session preparation failed.';
    record('Session setup failed; capture remains stopped.');
  } finally { prepare.disabled = false; }
};
window.addEventListener('pagehide', () => { dispose?.(); });
