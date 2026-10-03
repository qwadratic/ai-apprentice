// Step 1: account tier, quota and ElevenAgents (convai) availability.
import { api } from './lib.mjs';

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in (o ?? {})).map((k) => [k, o[k]]));

const sub = await api('/v1/user/subscription');
console.log('GET /v1/user/subscription ->', sub.status);
if (sub.ok) {
  console.log(
    pick(sub.json, [
      'tier', 'status', 'character_count', 'character_limit', 'voice_limit', 'voice_slots_used',
      'professional_voice_limit', 'can_use_instant_voice_cloning', 'can_use_professional_voice_cloning',
      'next_character_count_reset_unix', 'billing_period', 'currency',
    ]),
  );
  console.log('all keys:', Object.keys(sub.json).filter((k) => !/invoice|email|stripe|customer/i.test(k)).join(', '));
} else console.log(sub.json);

const user = await api('/v1/user');
console.log('GET /v1/user ->', user.status, user.ok ? Object.keys(user.json).join(', ') : JSON.stringify(user.json).slice(0, 300));

const agents = await api('/v1/convai/agents?page_size=30');
console.log('GET /v1/convai/agents ->', agents.status);
if (agents.ok) {
  const list = agents.json.agents ?? [];
  console.log('agent count:', list.length, list.map((a) => a.name).join(' | '));
} else console.log(JSON.stringify(agents.json).slice(0, 400));

const settings = await api('/v1/convai/settings');
console.log('GET /v1/convai/settings ->', settings.status, JSON.stringify(settings.json).slice(0, 600));
