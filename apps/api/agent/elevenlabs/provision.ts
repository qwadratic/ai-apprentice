// Step 2: idempotently create or update the dev agent from agents.config.json.
// Usage: node provision.ts [--dry]
import { readFileSync } from 'node:fs';
import { api } from './lib.ts';
import { parseAgentConfig, parseAgentList, parseAgentReadback, parseCreatedAgentId } from './types.ts';

const config = parseAgentConfig(JSON.parse(readFileSync(new URL('./agents.config.json', import.meta.url), 'utf8')));
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
const existing = parseAgentList(found.json).find((a) => a.name === config.name);

let id: string;
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
  const created = parseCreatedAgentId(r.json);
  if (created === undefined) {
    console.error('create reply has no agent_id');
    process.exit(1);
  }
  id = created;
}
console.log(existing ? 'updated' : 'created', config.name);
console.log('ELEVENLABS_AGENT_ID_INTERVIEWER=' + id);

// Read back the stored config to verify what the server actually kept.
const back = parseAgentReadback((await api(`/v1/convai/agents/${id}`)).json);
const cc = back.conversation_config ?? {};
const builtIn = cc.agent?.prompt?.built_in_tools ?? {};
console.log('readback:', JSON.stringify({
  llm: cc.agent?.prompt?.llm,
  first_message: cc.agent?.first_message,
  language: cc.agent?.language,
  turn: cc.turn,
  text_only: cc.conversation?.text_only,
  max_duration_seconds: cc.conversation?.max_duration_seconds,
  tools: Object.keys(builtIn).filter((k) => builtIn[k]),
  tts: cc.tts?.model_id,
  auth: back.platform_settings?.auth,
  overrides: back.platform_settings?.overrides,
}, null, 1));
