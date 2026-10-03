// Step 4: text-only conversation test with the global WebSocket (Node 22).
// Phase A: 45 s of contextual_update every 3 s -> expect zero agent replies.
// Phase B: one non-[ASK] user_message -> expect silence (skip_turn).
// Phase C: [ASK] user_messages -> expect the exact question, measure latency.
// Usage: ELEVENLABS_AGENT_ID_INTERVIEWER=... node textonly-test.mjs [--quick]
import { getSignedUrl } from './signed-url.mjs';

const QUICK = process.argv.includes('--quick');
const PHASE_A_MS = QUICK ? 9000 : 45000;
const QUESTION = 'Why did you type the delivery address instead of attaching the screenshot?';
const ASK_TRIES = 5;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);

const s = await getSignedUrl();
if (!s.ok) {
  console.log('signed url failed', s.status, s.error);
  process.exit(1);
}
const ws = new WebSocket(s.url);

const typeCounts = {};
const agentReplies = []; // {t, text, phase}
const toolEvents = [];
let phase = 'init';
let audioEvents = 0;
let askSentAt = 0;
const askResults = [];
let meta = null;
const partsByPhase = {};
const emptyCheck = {};
const silentTurns = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => ws.send(JSON.stringify(o));

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  typeCounts[m.type] = (typeCounts[m.type] ?? 0) + 1;
  switch (m.type) {
    case 'ping':
      setTimeout(() => send({ type: 'pong', event_id: m.ping_event.event_id }), m.ping_event.ping_ms ?? 0);
      break;
    case 'conversation_initiation_metadata':
      meta = m.conversation_initiation_metadata_event;
      console.log(ts(), 'metadata keys:', Object.keys(meta).join(','), 'audio fmt:', meta.agent_output_audio_format);
      break;
    case 'audio':
      audioEvents++;
      break;
    case 'agent_response': {
      const text = m.agent_response_event?.agent_response ?? '';
      agentReplies.push({ t: Date.now(), text, phase });
      console.log(ts(), `agent_response [${phase}]:`, JSON.stringify(text));
      if (phase === 'C' && askSentAt && askResults.length < ASK_TRIES && !askResults.some((r) => r.pending)) {
        // handled by the sender loop via agentReplies
      }
      break;
    }
    case 'agent_chat_response_part': {
      // Streaming parts (text-only mode). An empty start/stop pair means the LLM took a turn and said nothing (skip_turn).
      const p = m.text_response_part;
      if (p.type === 'delta' && p.text) partsByPhase[phase] = (partsByPhase[phase] ?? 0) + 1;
      if (p.type === 'start') emptyCheck[p.response_id] = { phase, text: '' };
      if (p.type === 'delta') emptyCheck[p.response_id].text += p.text;
      if (p.type === 'stop' && !emptyCheck[p.response_id].text) {
        silentTurns.push(emptyCheck[p.response_id].phase);
        console.log(ts(), `silent LLM turn (empty response) in phase ${phase}`);
      }
      break;
    }
    case 'user_transcript':
    case 'vad_score':
      break;
    default:
      if (!['agent_response_correction'].includes(m.type)) {
        toolEvents.push({ type: m.type, keys: Object.keys(m).join(',') });
        console.log(ts(), 'event', m.type, JSON.stringify(m).slice(0, 220));
      }
  }
});

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
});
console.log(ts(), 'connected');
send({
  type: 'conversation_initiation_client_data',
  conversation_config_override: { conversation: { text_only: true } },
});

const closeAndReport = (code = 0) => {
  try { ws.close(1000, 'done'); } catch {}
  console.log('\n=== summary ===');
  console.log('live seconds:', ((Date.now() - t0) / 1000).toFixed(1));
  console.log('event type counts:', JSON.stringify(typeCounts));
  console.log('audio events:', audioEvents);
  console.log('text parts by phase:', JSON.stringify(partsByPhase), 'silent LLM turns by phase:', JSON.stringify(silentTurns));
  console.log('phase A replies:', agentReplies.filter((r) => r.phase === 'A').length);
  console.log('phase B replies:', agentReplies.filter((r) => r.phase === 'B').length);
  console.log('ask results:', JSON.stringify(askResults, null, 1));
  console.log('other events:', JSON.stringify(toolEvents.slice(0, 20)));
  setTimeout(() => process.exit(code), 300);
};
ws.addEventListener('close', (e) => console.log(ts(), 'closed', e.code, e.reason));

// Give the session a moment to initialise (and to reveal whether an empty first message stays silent).
await sleep(2500);
console.log(ts(), 'replies before any input (empty first message):', agentReplies.length);

phase = 'A';
const events = [
  'Screen: order table opened, customer_07 row selected.',
  'Screen: expert opened email composer addressed to customer_07.',
  'Screen: expert pasted delivery address and delivery time as plain text into the email body.',
  'Screen: no screenshot attached to the email.',
  'Expert typing in email body.',
];
let i = 0;
const endA = Date.now() + PHASE_A_MS;
while (Date.now() < endA) {
  send({ type: 'contextual_update', text: events[i++ % events.length] });
  await sleep(3000);
}
console.log(ts(), `phase A done: ${agentReplies.filter((r) => r.phase === 'A').length} replies`);

phase = 'B';
send({ type: 'user_message', text: 'Okay, I will attach the order table next.' });
await sleep(8000);
console.log(ts(), `phase B done: ${agentReplies.filter((r) => r.phase === 'B').length} replies (expect 0)`);

phase = 'C';
for (let n = 1; n <= ASK_TRIES; n++) {
  const before = agentReplies.length;
  askSentAt = Date.now();
  send({ type: 'user_message', text: `[ASK] ${QUESTION}` });
  const deadline = Date.now() + 15000;
  while (agentReplies.length === before && Date.now() < deadline) await sleep(50);
  if (agentReplies.length > before) {
    const r = agentReplies[before];
    askResults.push({ try: n, ms: r.t - askSentAt, verbatim: r.text.trim() === QUESTION, text: r.text });
  } else {
    askResults.push({ try: n, ms: null, verbatim: false, text: null });
  }
  await sleep(3000); // let any further agent output settle
}
closeAndReport(0);
