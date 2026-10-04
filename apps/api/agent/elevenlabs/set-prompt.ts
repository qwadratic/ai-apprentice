// Sets the live prompt and greeting of one ElevenLabs agent from prompts/<role>.md, after backing up the live ones.
// Usage (on the VM, with /etc/apprentice/env loaded): node set-prompt.ts --role interviewer|tutor [--dry]
// Needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID_INTERVIEWER or ELEVENLABS_AGENT_ID_TUTOR. Prints status codes and
// lengths only, never the key or the prompt text. The backup goes to BACKUP_DIR (default /var/lib/apprentice/el-prompts).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './lib.ts';

const args = process.argv.slice(2);
const role = args[args.indexOf('--role') + 1];
const dry = args.includes('--dry');
if (role !== 'interviewer' && role !== 'tutor') { console.error('usage: node set-prompt.ts --role interviewer|tutor [--dry]'); process.exit(2); }
const id = process.env[role === 'tutor' ? 'ELEVENLABS_AGENT_ID_TUTOR' : 'ELEVENLABS_AGENT_ID_INTERVIEWER'];
if (!id) { console.error(`the agent id for ${role} is not set`); process.exit(2); }

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prompts', `${role}.md`), 'utf8').trim();
const greeting = /^Greeting: .*?"([^"]+)"/m.exec(text)?.[1] ?? '';
const prompt = text.replace(/^Greeting: .*$/m, '').trim();

interface AgentPrompt { prompt?: string }
interface AgentBody { conversation_config?: { agent?: { first_message?: string; prompt?: AgentPrompt } } }
const live = await api(`/v1/convai/agents/${id}`);
console.log('read', live.status);
if (live.status !== 200) process.exit(1);
const agent = (live.json as AgentBody).conversation_config?.agent ?? {};
const dir = process.env['BACKUP_DIR'] ?? '/var/lib/apprentice/el-prompts';
mkdirSync(dir, { recursive: true });
const backup = join(dir, `${role}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(backup, JSON.stringify({ first_message: agent.first_message ?? '', prompt: agent.prompt?.prompt ?? '' }, null, 2), { mode: 0o600 });
console.log('backup', backup, 'live prompt chars', (agent.prompt?.prompt ?? '').length, 'new prompt chars', prompt.length);
if (dry) process.exit(0);

const patch = await api(`/v1/convai/agents/${id}`, { method: 'PATCH', body: { conversation_config: { agent: { first_message: greeting, prompt: { prompt } } } } });
console.log('patch', patch.status);
const back = await api(`/v1/convai/agents/${id}`);
const now = (back.json as AgentBody).conversation_config?.agent;
console.log('verify prompt', now?.prompt?.prompt === prompt, 'greeting', now?.first_message === greeting);
