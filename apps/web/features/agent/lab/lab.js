// Agent lab: a no-build page that drives one ElevenAgents session from the browser.
// Prototype for stream B (TASK-3.21). It gets folded into the app shell later (TASK-3.8, TASK-3.9).
//
// Secrets: the page never holds an API key. The backend (VM API) mints a signed URL;
// ?agent=<id> is for a PUBLIC test agent only.
//
// Backend route (decided by the coordinator, served by the VM):
//   GET {base}/agent/elevenlabs/signed-url?role=interviewer
//   200 application/json  {"signed_url": "wss://..."}
// {base} is the "API base" field (or ?api=<base>). The signed URL is a secret: never logged here.
//
// Session log routes (TASK-3.22, served by the VM; origin-checked, 256 KB body limit):
//   POST {base}/agent/sessions/{sessionId}/events
//     body {"conversationId": "<ElevenLabs id, omitted until connected>",
//           "events": [{"t": <Date.now() ms>, "dir": "sent"|"recv"|"sys"|"err", "type": "CONTEXT", "text": "..."}]}
//     Sent every 2 s while events are queued; at most 200 events (and about 200 KB) per request.
//     A failed request keeps the events queued and they are retried on the next tick.
//     The server appends them as JSONL under /var/lib/apprentice/sessions/. Any 2xx counts as accepted.
//   POST {base}/agent/sessions/{sessionId}/finish
//     body {"conversationId": "<id>"}; the server fetches the ElevenLabs transcript, metadata and audio.
//     Answer: JSON {"transcriptStored": true|false} (anything else is shown as "transcript stored: no").
// sessionId is crypto.randomUUID(), created on Start session and shown under the Clipa card.
// Every line of the visible event log is queued, with one rule: signed WebSocket URLs (wss://...),
// xi-api-key values and sk_ keys are removed from the text before it is logged or queued.
// Off the record: one SYS event is queued and flushed, then nothing more is queued, the voice session
// ends and finish is called. It does not delete what was already sent.
import { Conversation } from 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm';

const $ = (id) => document.getElementById(id);
const clipa = $('clipa');
const els = {
  apiBase: $('apiBase'), start: $('btnStart'), end: $('btnEnd'), off: $('btnOff'),
  mock: $('btnMock'), askForm: $('askForm'), askText: $('askText'), ask: $('btnAsk'),
  notice: $('notice'), log: $('log'), clear: $('btnClear'),
  stateLabel: $('stateLabel'), connLine: $('connLine'), sessionId: $('sessionId'),
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

// Signed URLs and keys never reach the visible log or the server log.
function scrub(text) {
  return String(text)
    .replace(/wss?:\/\/\S+/gi, '[url removed]')
    .replace(/xi-api-key\S*/gi, '[key removed]')
    .replace(/sk_[A-Za-z0-9]{16,}/g, '[key removed]');
}

function log(kind, tag, rawText) {
  const text = scrub(rawText);
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
  enqueue(kind, tag, text);
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

// ---- Server log ----------------------------------------------------------
// One object per session. While `recording` is true every log line is queued and flushed.
const FLUSH_MS = 2000;
const MAX_BATCH_EVENTS = 200;
const MAX_BATCH_CHARS = 200000;   // the server refuses bodies over 256 KB
const MAX_TEXT_CHARS = 4000;
const EVENTS_TIMEOUT_MS = 8000;
const FINISH_TIMEOUT_MS = 30000;   // the server polls ElevenLabs for up to ~15 s before it answers
const PERMANENT_FAILURES = [400, 403, 404, 413];
let session = null;               // {id, conversationId, queue, recording, timer, flushing, failedShown, finished}

function apiBase() { return els.apiBase.value.trim().replace(/\/+$/, ''); }

function newSession() {
  session = {
    id: crypto.randomUUID(), conversationId: '', queue: [], recording: true,
    timer: null, flushing: false, chain: null, failedShown: false, finished: false, base: apiBase(), ending: false,
  };
  const me = session;
  me.timer = setInterval(() => { if (!me.flushing && !me.gaveUp && me.queue.length) flush(me); }, FLUSH_MS);
  els.sessionId.textContent = session.id;
  return session;
}

function enqueue(kind, tag, text) {
  const s = session;
  if (!s || !s.recording) return;
  s.queue.push({
    t: Date.now(), dir: kind, type: tag,
    text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}...[truncated]` : text,
  });
}

function sessionUrl(s, route) {
  return `${s.base}/agent/sessions/${encodeURIComponent(s.id)}/${route}`;
}

function nextBatch(s) {
  const batch = [];
  let chars = 0;
  for (const ev of s.queue) {
    const size = ev.text.length + 80;
    if (batch.length >= MAX_BATCH_EVENTS || (batch.length && chars + size > MAX_BATCH_CHARS)) break;
    batch.push(ev);
    chars += size;
  }
  return batch;
}

// Sends the queue in batches. Returns true when the queue is empty. A failure keeps the events.
function flush(s) {
  if (!s) return Promise.resolve(true);
  s.chain = (s.chain || Promise.resolve()).then(() => doFlush(s));   // one request at a time, in order
  return s.chain;
}

async function doFlush(s) {
  s.flushing = true;
  try {
    while (s.queue.length) {
      const batch = nextBatch(s);
      const body = { events: batch };
      if (s.conversationId) body.conversationId = s.conversationId;
      let res;
      try {
        res = await fetch(sessionUrl(s, 'events'), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
        });
      } catch (e) {
        res = null;
      }
      if (res && PERMANENT_FAILURES.includes(res.status)) {
        // The server will not accept this session's log (route missing, origin refused, bad body): stop retrying.
        s.gaveUp = true;
        clearInterval(s.timer);
        s.timer = null;
        if (s === session) err(`Session log upload refused (${res.status}); upload stopped for this session.`);
        return false;
      }
      if (!res || !res.ok) {
        if (!s.failedShown) {
          s.failedShown = true;
          // Shown once. Events stay queued and are retried every tick.
          if (s === session) err(`Session log upload failed${res ? ` (${res.status})` : ''}. Events stay queued and are retried.`);
        }
        return false;
      }
      s.failedShown = false;
      s.queue.splice(0, batch.length);
    }
    return true;
  } finally {
    s.flushing = false;
  }
}

// Flush what is left, ask the server to store the ElevenLabs conversation, stop the timer.
async function finishSession(s) {
  if (!s || s.finished) return;
  s.finished = true;
  clearInterval(s.timer);
  s.timer = null;
  s.recording = false;
  if (!s.gaveUp) await flush(s);
  let line;
  try {
    const res = await fetch(sessionUrl(s, 'finish'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: s.conversationId || null }),
      signal: AbortSignal.timeout(FINISH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`finish answered ${res.status}`);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const stored = !!(body && (body.transcriptStored || body.transcript_stored));
    line = ['sys', `Session log saved on the server: ${s.id}, transcript stored: ${stored ? 'yes' : 'no'}`];
  } catch (e) {
    line = ['err', `Session log could not be finished on the server (${e && e.message ? e.message : e}). Events not sent: ${s.queue.length}.`];
  }
  if (line[0] === 'sys') sys(line[1]); else err(line[1]);
}

// ---- Session -------------------------------------------------------------
let starting = false;
let liveAnnounced = false;

function announceLive() {
  if (liveAnnounced) return;
  liveAnnounced = true;
  sys('Session started. Microphone is live.');
}

async function getSessionConfig() {
  if (publicAgentId) {
    sys('Using public agent id from the URL (testing only).');
    return { agentId: publicAgentId };
  }
  const base = apiBase();
  const url = `${base}/agent/elevenlabs/signed-url?role=interviewer`;
  sys(`GET ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
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
  liveAnnounced = false;
  offRecord = false;
  const s = newSession();
  sys(`Session id ${s.id} (the server log is stored under this id).`);
  render();
  try {
    const cfg = await getSessionConfig();
    conversation = await Conversation.startSession({
      ...cfg,
      onConnect: ({ conversationId } = {}) => {
        if (conversationId) s.conversationId = conversationId;
        recv('CONNECT', `conversation ${conversationId || ''}`.trim());
        announceLive();
      },
      onDisconnect: (d) => {
        recv('DISCONNECT', d && d.reason ? String(d.reason) : '');
        markDisconnected(s);
      },
      onStatusChange: ({ status }) => {
        recv('STATUS', status);
        connected = status === 'connected';
        if (connected) announceLive();
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
    // The conversation id comes from onConnect; getId() (BaseConversation, SDK 1.26.0) is the fallback.
    if (!s.conversationId && conversation && typeof conversation.getId === 'function') {
      try { s.conversationId = conversation.getId() || ''; } catch { /* keep empty */ }
    }
    // Connected state and the "live" log line come from the callbacks, not from this resolve.
  } catch (e) {
    err(e && e.message ? e.message : String(e));
    notice(e && e.message ? e.message : String(e));
    conversation = null;
    connected = false;
    await finishSession(s);
  } finally {
    starting = false;
    render();
  }
}

function markDisconnected(s) {
  connected = false;
  thinking = false;
  mode = 'listening';
  conversation = null;
  stopMock();
  render();
  // A disconnect that we did not cause (network, agent hang-up) also closes the server log.
  if (s && !s.ending) finishSession(s);
}

async function endSession(reason) {
  stopMock();
  const s = session;
  if (s) s.ending = true;
  const c = conversation;
  conversation = null;
  connected = false;
  thinking = false;
  if (c) {
    try { await c.endSession(); } catch (e) { err(`endSession: ${e && e.message ? e.message : e}`); }
  }
  sys(reason);
  render();
  await finishSession(s);
}

// Off the record: the switch is the last thing that is logged; nothing after it is queued.
// The microphone and the voice session close first; uploading what was logged before the switch comes after,
// so a slow or unreachable server can never keep the microphone open.
async function goOffRecord() {
  const s = session;
  if (s && s.recording) {
    sys('Off the record: capture and upload stopped');
    s.recording = false;
  }
  offRecord = true;
  await endSession('Off the record: session ended, microphone closed. What was already sent is not deleted or recalled.');
  render();
}

// Closing or reloading the tab: close the voice session and send what is queued with keepalive (best effort).
window.addEventListener('pagehide', () => {
  const s = session;
  const c = conversation;
  conversation = null;
  if (c) { try { c.endSession(); } catch { /* page is going away */ } }
  if (!s || s.finished || s.gaveUp) return;
  s.finished = true;
  s.recording = false;
  clearInterval(s.timer);
  const post = (route, body) => {
    try {
      fetch(sessionUrl(s, route), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
  };
  const batch = nextBatch(s).filter((_, i) => i < 50);   // keepalive bodies are limited to 64 KB
  if (batch.length) post('events', { conversationId: s.conversationId || undefined, events: batch });
  post('finish', { conversationId: s.conversationId || null });
});

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
els.off.addEventListener('click', goOffRecord);
els.mock.addEventListener('click', toggleMock);
els.clear.addEventListener('click', () => { els.log.textContent = ''; });
els.askForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = els.askText.value.trim();
  if (q) askNow(q);
});

render();
sys('Ready. Start a session to talk to the agent.');
