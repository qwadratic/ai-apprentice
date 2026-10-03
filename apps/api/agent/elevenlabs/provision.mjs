// Step 2: idempotently create or update the dev agent from agents.config.json.
// Usage: node provision.mjs [--dry]
import { readFileSync } from 'node:fs';
import { api } from './lib.mjs';

const config = JSON.parse(readFileSync(new URL('./agents.config.json', import.meta.url), 'utf8'));
if (process.argv.includes('--dry')) {
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

// Find by exact name (list is paginated; search narrows it).
const found = await api(`/v1/convai/agents?page_size=100&search=${encodeURIComponent(config.name)}`);
if (!found.ok) {
  console.error('list failed', found.status, JSON.stringify(found.json).slice(0, 500));
  process.exit(1);
}
const existing = (found.json.agents ?? []).find((a) => a.name === config.name);

let id;
if (existing) {
  id = existing.agent_id;
  const r = await api(`/v1/convai/agents/${id}`, { method: 'PATCH', body: config });
  console.log('PATCH', r.status);
  if (!r.ok) {
    console.error(JSON.stringify(r.json).slice(0, 1500));
    process.exit(1);
  }
} else {
  const r = await api('/v1/convai/agents/create', { method: 'POST', body: config });
  console.log('CREATE', r.status);
  if (!r.ok) {
    console.error(JSON.stringify(r.json).slice(0, 1500));
    process.exit(1);
  }
  id = r.json.agent_id;
}
console.log(existing ? 'updated' : 'created', config.name);
console.log('ELEVENLABS_AGENT_ID_INTERVIEWER=' + id);

// Read back the stored config to verify what the server actually kept.
const back = await api(`/v1/convai/agents/${id}`);
const cc = back.json.conversation_config ?? {};
console.log('readback:', JSON.stringify({
  llm: cc.agent?.prompt?.llm,
  first_message: cc.agent?.first_message,
  language: cc.agent?.language,
  turn: cc.turn,
  text_only: cc.conversation?.text_only,
  tools: Object.keys(cc.agent?.prompt?.built_in_tools ?? {}).filter((k) => cc.agent.prompt.built_in_tools[k]),
  tts: cc.tts?.model_id,
  auth: back.json.platform_settings?.auth,
  overrides: back.json.platform_settings?.overrides,
}, null, 1));
