import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentOptions, FetchFn } from '../agent/index.ts';
import { resolveConfig } from '../agent/config.ts';
import { CLIPA_FALLBACK_VOICE, DEFAULT_VOICES, LOOKUP_RETRY_MS, VOICEOVER_MODEL, loadLines } from '../agent/voiceover.ts';
import { EL_AGENT, EL_KEY, start, tempDir } from './agent-helpers.ts';

const LINES = {
  lines: [
    { id: 'v01', voice: 'narrator', text: 'Clipa learns why the expert does each step.' },
    { id: 'v02', voice: 'clipa', text: 'Why did you type the address instead of attaching it?' },
    { id: 'v03', voice: 'pirate', text: 'Not a known voice.' },
    { id: 'x04', voice: 'narrator', text: 'Bad id.' },
    { id: 'v05', voice: 'expert', text: 'x'.repeat(401) },
  ],
};
const AGENT_VOICE = 'agentVoice1234567890';

interface Call { url: string; key: string | null; method: string; body: unknown }
function stub(opts: { tts?: (call: Call) => Response | Promise<Response>; agent?: () => Response } = {}): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = String(input);
    const call: Call = { url, key: new Headers(init?.headers).get('xi-api-key'), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.includes('/v1/convai/agents/')) return opts.agent ? opts.agent() : Response.json({ conversation_config: { tts: { voice_id: AGENT_VOICE } } });
    if (url.includes('/v1/text-to-speech/')) return opts.tts ? opts.tts(call) : new Response(new Uint8Array([0xff, 0xfb, 1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    return new Response('unexpected', { status: 500 });
  };
  return { fetch: fetchFn, calls };
}

async function setup(t: TestContext, options: AgentOptions = {}) {
  const dir = await tempDir(t);
  const linesFile = join(dir, 'lines.json');
  await writeFile(linesFile, JSON.stringify(LINES));
  const voiceoverDir = join(dir, 'cache', 'voiceover');
  const logs: Array<Record<string, unknown>> = [];
  const h = await start(t, { voiceoverLinesFile: linesFile, voiceoverDir, log: (f) => { logs.push(f); }, ...options });
  return { ...h, voiceoverDir, logs };
}

const tts = (calls: Call[]): Call[] => calls.filter((c) => c.url.includes('/text-to-speech/'));
const audio = (bytes: number[]): Response => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'audio/mpeg' } });

test('voiceover loader keeps only valid whitelisted entries', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'lines.json');
  await writeFile(file, JSON.stringify(LINES));
  assert.deepEqual([...(await loadLines(file)).keys()], ['v01', 'v02']);
  assert.equal((await loadLines(join(dir, 'missing.json'))).size, 0);
  await writeFile(file, '{not json');
  assert.equal((await loadLines(file)).size, 0);
});

test('the shipped voiceover lines file is valid: no entry is silently dropped, ids run v01, v02, ...', async () => {
  const { voiceoverLinesFile } = resolveConfig({ log: () => {} }, {});
  const raw = JSON.parse(await readFile(voiceoverLinesFile, 'utf8')) as { lines: unknown[] };
  const loaded = [...(await loadLines(voiceoverLinesFile)).keys()];
  assert.ok(loaded.length > 0);
  assert.equal(loaded.length, raw.lines.length, 'every shipped line passes validation');
  assert.deepEqual(loaded, loaded.map((_, i) => `v${String(i + 1).padStart(2, '0')}`));
});

test('voiceover: a failed agent lookup is not retried on every public request', async (t) => {
  let clock = 1_000_000;
  const s = stub({ agent: () => new Response('nope', { status: 401 }) });
  const { base } = await setup(t, { fetch: s.fetch, now: () => clock });
  const lookups = (): number => s.calls.filter((c) => c.url.includes('/convai/agents/')).length;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/api/agent/voiceover/v02`);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  assert.equal(lookups(), 1, 'one lookup, then the fallback voice until the retry window passes');
  assert.equal(tts(s.calls).length, 1, 'the fallback line is cached');
  clock += LOOKUP_RETRY_MS;
  const later = await fetch(`${base}/api/agent/voiceover/v02`);
  assert.equal(later.status, 200);
  await later.arrayBuffer();
  assert.equal(lookups(), 2, 'retried after the window');
});

test('voiceover: when the cache dir cannot be written, the line is kept in memory and not generated again', async (t) => {
  const dir = await tempDir(t);
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'a file, so the cache dir below it cannot be created');
  const s = stub();
  const { base, logs } = await setup(t, { fetch: s.fetch, voiceoverDir: join(blocker, 'voiceover') });
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/api/agent/voiceover/v01`);
    assert.equal(r.status, 200);
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0xff, 0xfb, 1, 2, 3]);
  }
  assert.equal(tts(s.calls).length, 1);
  assert.equal(logs.filter((l) => String(l.msg).startsWith('voiceover: cache write failed')).length, 1);
});

test('voiceover: unknown and invalid line ids are 404 without any upstream call', async (t) => {
  const s = stub();
  const { base } = await setup(t, { fetch: s.fetch });
  for (const id of ['v99', 'v03', 'x04', 'v05', '..%2Fetc']) {
    const r = await fetch(`${base}/api/agent/voiceover/${id}`);
    assert.equal(r.status, 404, id);
    assert.deepEqual(await r.json(), { ok: false, error: 'unknown_line' });
  }
  assert.equal(s.calls.length, 0);
});

test('voiceover: without a key the endpoint answers 503', async (t) => {
  const s = stub();
  const { base } = await setup(t, { fetch: s.fetch, elevenLabsApiKey: '' });
  const r = await fetch(`${base}/api/agent/voiceover/v01`);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: 'elevenlabs_not_configured' });
  assert.equal(s.calls.length, 0);
});

test('voiceover: first call generates and caches, later calls (both prefixes) are served from disk', async (t) => {
  const s = stub();
  const { base, voiceoverDir, logs } = await setup(t, { fetch: s.fetch });
  const r = await fetch(`${base}/api/agent/voiceover/v01`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0xff, 0xfb, 1, 2, 3]);
  const calls = tts(s.calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.key, EL_KEY);
  assert.equal(calls[0]?.url, `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICES.narrator}?output_format=mp3_44100_128`);
  assert.deepEqual(calls[0]?.body, { text: LINES.lines[0]?.text, model_id: VOICEOVER_MODEL });
  const files = await readdir(voiceoverDir);
  assert.equal(files.length, 1);
  assert.match(files[0] ?? '', /^[0-9a-f]{64}\.mp3$/);
  const again = await fetch(`${base}/api/agent/voiceover/v01`);
  assert.equal(again.status, 200);
  assert.equal((await again.arrayBuffer()).byteLength, 5);
  const bare = await fetch(`${base}/agent/voiceover/v01`);
  assert.equal(bare.status, 200);
  await bare.arrayBuffer();
  assert.equal(tts(s.calls).length, 1, 'cache hits make no upstream call');
  const generated = logs.filter((l) => l.msg === 'voiceover generated');
  assert.equal(generated.length, 1);
  assert.equal(generated[0]?.id, 'v01');
  assert.equal(generated[0]?.bytes, 5);
  assert.equal(typeof generated[0]?.ms, 'number');
  assert.ok(!JSON.stringify(logs).includes(EL_KEY));
});

test('voiceover: concurrent requests share one upstream call, and upstream calls never overlap', async (t) => {
  let active = 0;
  let maxActive = 0;
  const s = stub({
    tts: async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return audio([9, 9, 9]);
    },
  });
  const { base } = await setup(t, { fetch: s.fetch, voiceoverVoices: { clipa: 'clipaOverride123' } });
  const paths = ['v01', 'v01', 'v01', 'v02'];
  const rs = await Promise.all(paths.map((id) => fetch(`${base}/api/agent/voiceover/${id}`)));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200]);
  await Promise.all(rs.map((r) => r.arrayBuffer()));
  assert.equal(tts(s.calls).length, 2, 'one call per distinct line');
  assert.equal(maxActive, 1);
});

test('voiceover: upstream failure is 502 without the upstream body, and nothing is cached', async (t) => {
  let fail = true;
  const s = stub({ tts: () => (fail ? new Response('{"detail":"secret upstream detail"}', { status: 401 }) : audio([1])) });
  const { base, voiceoverDir, logs } = await setup(t, { fetch: s.fetch });
  const r = await fetch(`${base}/api/agent/voiceover/v01`);
  assert.equal(r.status, 502);
  const body = await r.text();
  assert.ok(!body.includes('secret upstream detail'));
  assert.deepEqual(JSON.parse(body), { ok: false, error: 'elevenlabs_error', upstream_status: 401 });
  assert.ok(!JSON.stringify(logs).includes('secret upstream detail'));
  assert.deepEqual(await readdir(voiceoverDir).catch(() => []), []);
  fail = false;
  const retry = await fetch(`${base}/api/agent/voiceover/v01`);
  assert.equal(retry.status, 200, 'a later call retries');
  await retry.arrayBuffer();

  const down = stub({ tts: () => { throw new Error('network down'); } });
  const h2 = await setup(t, { fetch: down.fetch });
  const r2 = await fetch(`${h2.base}/api/agent/voiceover/v01`);
  assert.equal(r2.status, 502);
  assert.deepEqual(await r2.json(), { ok: false, error: 'elevenlabs_unreachable' });
});

test('voiceover: voice overrides replace the defaults', async (t) => {
  const s = stub();
  const { base } = await setup(t, { fetch: s.fetch, voiceoverVoices: { narrator: 'narratorOverride1', clipa: 'clipaOverride123' } });
  for (const id of ['v01', 'v02']) {
    const r = await fetch(`${base}/api/agent/voiceover/${id}`);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  const urls = tts(s.calls).map((c) => c.url);
  assert.ok(urls[0]?.includes('/text-to-speech/narratorOverride1?'));
  assert.ok(urls[1]?.includes('/text-to-speech/clipaOverride123?'));
  assert.equal(s.calls.filter((c) => c.url.includes('/convai/agents/')).length, 0, 'no agent lookup when clipa is overridden');
});

test('voiceover: clipa speaks with the interviewer agent voice, read once; a failed read falls back', async (t) => {
  const s = stub();
  const { base } = await setup(t, { fetch: s.fetch });
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/agent/voiceover/v02`);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  const lookups = s.calls.filter((c) => c.url.includes('/convai/agents/'));
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0]?.url, `https://api.elevenlabs.io/v1/convai/agents/${EL_AGENT}`);
  assert.equal(lookups[0]?.key, EL_KEY);
  assert.ok(tts(s.calls)[0]?.url.includes(`/text-to-speech/${AGENT_VOICE}?`));

  const broken = stub({ agent: () => new Response('nope', { status: 404 }) });
  const h2 = await setup(t, { fetch: broken.fetch });
  const r2 = await fetch(`${h2.base}/api/agent/voiceover/v02`);
  assert.equal(r2.status, 200);
  await r2.arrayBuffer();
  assert.ok(tts(broken.calls)[0]?.url.includes(`/text-to-speech/${CLIPA_FALLBACK_VOICE}?`));
});

test('voiceover: ELEVENLABS_VOICEOVER_VOICES and MEDIA_DIR are read from the environment', () => {
  const logs: unknown[] = [];
  const log = (f: unknown): void => { logs.push(f); };
  assert.deepEqual(resolveConfig({ log }, { ELEVENLABS_VOICEOVER_VOICES: '{"narrator":"abcdEFGH1234","clipa":7}' }).voiceoverVoices, { narrator: 'abcdEFGH1234' });
  assert.equal(logs.length, 0);
  assert.deepEqual(resolveConfig({ log }, { ELEVENLABS_VOICEOVER_VOICES: 'not json' }).voiceoverVoices, {});
  assert.equal(logs.length, 1);
  assert.equal(resolveConfig({ log }, { MEDIA_DIR: '/srv/media' }).voiceoverDir, '/srv/media/voiceover');
});
