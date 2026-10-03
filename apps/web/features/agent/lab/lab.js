// Agent lab: a no-build page that drives one ElevenAgents session from the browser.
// Prototype for stream B (TASK-3.21). It gets folded into the app shell later (TASK-3.8, TASK-3.9).
//
// Secrets: the page never holds an API key. The backend (VM API) mints a signed URL;
// ?agent=<id> is for a PUBLIC test agent only.
import { Conversation } from 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm';

const $ = (id) => document.getElementById(id);
const clipa = $('clipa');
const els = {
  apiBase: $('apiBase'), start: $('btnStart'), end: $('btnEnd'), off: $('btnOff'),
  mock: $('btnMock'), askForm: $('askForm'), askText: $('askText'), ask: $('btnAsk'),
  notice: $('notice'), log: $('log'), clear: $('btnClear'),
  stateLabel: $('stateLabel'), connLine: $('connLine'),
};

const params = new URLSearchParams(location.search);
if (params.get('api')) els.apiBase.value = params.get('api');
const publicAgentId = params.get('agent');

// ---- Mock Learn timeline -------------------------------------------------
// Mock observations of the customer_07 case, sent as contextual updates every 3 s.
// fixtures/agent (TASK-3.1) replaces this inline list later. Mocks are never presented as live.
const MOCK_TIMELINE = [
  '[screen] Order table: order for customer_07 opened.',
  '[screen] Delivery address and delivery window are visible in the order detail.',
  '[screen] Email draft to customer_07 opened (new reply).',
  '[screen] Order template screenshot attached to the email draft.',
  '[screen] Screenshot removed from the draft; delivery address and time typed into the email body as text.',
  '[screen] Preview of the email is open (not sent yet).',
];
const MOCK_INTERVAL_MS = 3000;

// ---- State ---------------------------------------------------------------
let conversation = null;
let connected = false;
let mode = 'listening';     // 'speaking' | 'listening'
let thinking = false;
let offRecord = false;
let mockTimer = null;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(kind, tag, text) {
  const li = document.createElement('li');
  li.className = kind;
  const t = document.createElement('time');
  t.textContent = ts();
  const g = document.createElement('span');
  g.className = 'tag';
  g.textContent = tag;
  li.append(t, g, document.createTextNode(text));
  els.log.append(li);
  els.log.scrollTop = els.log.scrollHeight;
}
const sent = (tag, text) => log('sent', tag, text);
const recv = (tag, text) => log('recv', tag, text);
const sys = (text) => log('sys', 'SYS', text);
const err = (text) => log('err', 'ERR', text);

function notice(text, info = false) {
  els.notice.hidden = !text;
  els.notice.textContent = text || '';
  els.notice.classList.toggle('info', info);
}

// Clipa: idle before connect, listening while connected, speaking, thinking after Ask now, off.
function render() {
  let state = 'idle';
  if (connected) state = mode === 'speaking' ? 'speaking' : (thinking ? 'thinking' : 'listening');
  if (offRecord) {
    clipa.setAttribute('off', '');
    els.stateLabel.textContent = 'off the record';
  } else {
    clipa.removeAttribute('off');
    els.stateLabel.textContent = state;
  }
  clipa.setAttribute('state', state);
  els.start.disabled = connected || starting;
  els.end.disabled = !connected;
  els.off.disabled = !connected;
  els.ask.disabled = !connected;
  els.connLine.textContent = connected
    ? (publicAgentId ? 'Connected (public agent, testing)' : 'Connected')
    : (starting ? 'Connecting...' : 'Not connected');
}

// ---- Session -------------------------------------------------------------
let starting = false;

async function getSessionConfig() {
  if (publicAgentId) {
    sys('Using public agent id from the URL (testing only).');
    return { agentId: publicAgentId };
  }
  const base = els.apiBase.value.trim().replace(/\/+$/, '');
  const url = `${base}/agent/elevenlabs/signed-url`;
  sys(`GET ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Cannot reach ${base} (network error or CORS). The signed-URL endpoint may not be deployed yet. Open the page with ?agent=<public agent id> to test without it.`);
  }
  if (!res.ok) {
    throw new Error(`${url} answered ${res.status}. The signed-URL endpoint is missing or refused the request. Open the page with ?agent=<public agent id> to test without it.`);
  }
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!body || typeof body.signed_url !== 'string') {
    throw new Error('The endpoint answered, but not with JSON {"signed_url": "..."}.');
  }
  sys('Signed URL received (not logged).');
  return { signedUrl: body.signed_url };
}

async function startSession() {
  if (connected || starting) return;
  notice('');
  starting = true;
  offRecord = false;
  render();
  try {
    const cfg = await getSessionConfig();
    conversation = await Conversation.startSession({
      ...cfg,
      onConnect: ({ conversationId } = {}) => recv('CONNECT', `conversation ${conversationId || ''}`.trim()),
      onDisconnect: (d) => {
        recv('DISCONNECT', d && d.reason ? String(d.reason) : '');
        markDisconnected();
      },
      onStatusChange: ({ status }) => {
        recv('STATUS', status);
        connected = status === 'connected';
        render();
      },
      onModeChange: ({ mode: m }) => {
        recv('MODE', m);
        mode = m;
        if (m === 'speaking') thinking = false;
        render();
      },
      onMessage: (m) => {
        thinking = thinking && m.source !== 'ai';
        recv(m.source === 'ai' ? 'AGENT' : 'USER', m.message);
        render();
      },
      onError: (message, ctx) => {
        err(typeof message === 'string' ? message : JSON.stringify(message));
        if (ctx) err(typeof ctx === 'string' ? ctx : JSON.stringify(ctx));
      },
    });
    connected = true;
    sys('Session started. Microphone is live.');
  } catch (e) {
    err(e && e.message ? e.message : String(e));
    notice(e && e.message ? e.message : String(e));
    conversation = null;
    connected = false;
  } finally {
    starting = false;
    render();
  }
}

function markDisconnected() {
  connected = false;
  thinking = false;
  mode = 'listening';
  conversation = null;
  stopMock();
  render();
}

async function endSession(reason) {
  stopMock();
  const c = conversation;
  conversation = null;
  connected = false;
  thinking = false;
  if (c) {
    try { await c.endSession(); } catch (e) { err(`endSession: ${e && e.message ? e.message : e}`); }
  }
  sys(reason);
  render();
}

// ---- Sending -------------------------------------------------------------
function sendContext(text) {
  if (!conversation || !connected) {
    sys(`Not sent (no session): ${text}`);
    return false;
  }
  conversation.sendContextualUpdate(text);
  sent('CONTEXT', text);
  return true;
}

function askNow(question) {
  if (!conversation || !connected) return;
  const text = `[ASK] ${question}`;
  conversation.sendUserMessage(text);
  sent('USER_MSG', text);
  thinking = true;
  render();
}

function stopMock() {
  if (mockTimer) { clearInterval(mockTimer); mockTimer = null; }
  els.mock.textContent = 'Play mock Learn session';
}

function toggleMock() {
  if (mockTimer) { stopMock(); sys('Mock playback stopped.'); return; }
  if (!connected && els.notice.hidden) notice('No session: the mock events will only appear in the log. Start a session to send them.', true);
  let i = 0;
  sys(`Mock Learn playback: ${MOCK_TIMELINE.length} events, one every ${MOCK_INTERVAL_MS / 1000} s (synthetic).`);
  els.mock.textContent = 'Stop mock playback';
  const step = () => {
    sendContext(MOCK_TIMELINE[i]);
    i += 1;
    if (i >= MOCK_TIMELINE.length) { stopMock(); sys('Mock playback finished.'); }
  };
  step();
  if (i < MOCK_TIMELINE.length) mockTimer = setInterval(step, MOCK_INTERVAL_MS);
}

// ---- Wiring --------------------------------------------------------------
els.start.addEventListener('click', startSession);
els.end.addEventListener('click', () => endSession('Session ended.'));
els.off.addEventListener('click', async () => {
  await endSession('Off the record: session ended, microphone closed. Data already sent is not recalled.');
  offRecord = true;
  render();
});
els.mock.addEventListener('click', toggleMock);
els.clear.addEventListener('click', () => { els.log.textContent = ''; });
els.askForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = els.askText.value.trim();
  if (q) askNow(q);
});

render();
sys('Ready. Start a session to talk to the agent.');
