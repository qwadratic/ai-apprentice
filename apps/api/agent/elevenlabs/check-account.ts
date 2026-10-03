// Step 1: account tier, quota and ElevenAgents (convai) availability.
import { api } from './lib.ts';
import { isRecord, parseAgentList, parseSubscription } from './types.ts';
import type { JsonRecord } from './types.ts';

const pick = (o: JsonRecord, keys: string[]): JsonRecord =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

const sub = await api('/v1/user/subscription');
console.log('GET /v1/user/subscription ->', sub.status);
if (sub.ok) {
  const s = parseSubscription(sub.json);
  console.log(
    pick(s, [
      'tier', 'status', 'character_count', 'character_limit', 'voice_limit', 'voice_slots_used',
      'professional_voice_limit', 'can_use_instant_voice_cloning', 'can_use_professional_voice_cloning',
      'next_character_count_reset_unix', 'billing_period', 'currency',
    ]),
  );
  console.log('all keys:', Object.keys(s).filter((k) => !/invoice|email|stripe|customer/i.test(k)).join(', '));
} else console.log(sub.json);

const user = await api('/v1/user');
console.log(
  'GET /v1/user ->',
  user.status,
  user.ok && isRecord(user.json) ? Object.keys(user.json).join(', ') : JSON.stringify(user.json).slice(0, 300),
);

const agents = await api('/v1/convai/agents?page_size=30');
console.log('GET /v1/convai/agents ->', agents.status);
if (agents.ok) {
  const list = parseAgentList(agents.json);
  console.log('agent count:', list.length, list.map((a) => a.name).join(' | '));
} else console.log(JSON.stringify(agents.json).slice(0, 400));

const settings = await api('/v1/convai/settings');
console.log('GET /v1/convai/settings ->', settings.status, JSON.stringify(settings.json).slice(0, 600));
