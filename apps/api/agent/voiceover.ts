// GET /api/agent/voiceover/:id: speaks one whitelisted line of the demo video's voice-over through ElevenLabs TTS.
// Public and unauthenticated, so it only ever voices lines from voiceover/lines.json, generates each line once and
// serves it from a disk cache afterwards. Upstream calls run one at a time. The key and upstream bodies are never logged.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import type { AgentConfig } from './config.ts';
import { isRecord } from './config.ts';

export const VOICEOVER_MODEL = 'eleven_multilingual_v2';
export const VOICE_ROLES = ['narrator', 'clipa', 'expert', 'newhire'] as const;
export type VoiceRole = typeof VOICE_ROLES[number];
export interface VoiceoverLine { id: string; voice: VoiceRole; text: string }

export const DEFAULT_VOICES: Record<Exclude<VoiceRole, 'clipa'>, string> = {
  narrator: 'JBFqnCBsd6RMkjVDRZzb',
  expert: 'pNInz6obpgDQGcFmaJgB',
  newhire: 'EXAVITQu4vr4xnSDxMaL',
};
/** Clipa speaks with the interviewer agent's voice; this one is used when the agent cannot be read. */
export const CLIPA_FALLBACK_VOICE = '21m00Tcm4TlvDq8ikWAM';

const LINE_ID = /^v\d{2}$/;
const MAX_TEXT = 400;
const MAX_AUDIO = 10 * 1024 * 1024;
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;
/** After a failed agent lookup, Clipa uses the fallback voice for this long before the lookup is tried again. */
export const LOOKUP_RETRY_MS = 5 * 60_000;

/** Reads the whitelist; a missing or malformed file is an empty list and invalid entries are skipped (first id wins). */
export async function loadLines(file: string): Promise<Map<string, VoiceoverLine>> {
  const lines = new Map<string, VoiceoverLine>();
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { return lines; }
  if (!isRecord(raw) || !Array.isArray(raw.lines)) return lines;
  for (const entry of raw.lines) {
    if (!isRecord(entry)) continue;
    const { id, voice, text } = entry;
    if (typeof id !== 'string' || !LINE_ID.test(id) || lines.has(id)) continue;
    if (typeof voice !== 'string' || !(VOICE_ROLES as readonly string[]).includes(voice)) continue;
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) continue;
    lines.set(id, { id, voice: voice as VoiceRole, text });
  }
  return lines;
}

type Generated = { ok: true; audio: Buffer } | { ok: false; error: 'elevenlabs_error' | 'elevenlabs_unreachable'; status?: number };

export function registerVoiceoverRoutes(app: Express, config: AgentConfig): void {
  const headers = { 'xi-api-key': config.elevenLabsApiKey };
  // At most one upstream call at a time overall: every ElevenLabs request goes through this chain.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const inflight = new Map<string, Promise<Generated>>();
  // Audio whose disk write failed, so a broken cache dir cannot turn every public request into a paid upstream call.
  // Keyed by cache file, so it is bounded by the whitelist like the disk cache.
  const kept = new Map<string, Buffer>();
  let clipaVoice: Promise<string> | undefined;
  let clipaFailedAt = Number.NEGATIVE_INFINITY;

  /** The interviewer agent's voice, read once; after a failed read the fallback is used, and the read is retried only
   *  after LOOKUP_RETRY_MS, so public requests cannot turn a persistent failure into one upstream call each. */
  const lookupClipaVoice = (): Promise<string> => {
    if (!config.interviewerAgentId) return Promise.resolve(CLIPA_FALLBACK_VOICE);
    if (!clipaVoice && config.now() - clipaFailedAt < LOOKUP_RETRY_MS) return Promise.resolve(CLIPA_FALLBACK_VOICE);
    clipaVoice ??= serial(async () => {
      const url = `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(config.interviewerAgentId)}`;
      const r = await config.fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { await r.arrayBuffer().catch(() => {}); throw new Error(`agent lookup ${r.status}`); }
      const agent: unknown = await r.json();
      const conversation = isRecord(agent) ? agent.conversation_config : undefined;
      const tts = isRecord(conversation) ? conversation.tts : undefined;
      const id = isRecord(tts) ? tts.voice_id : undefined;
      if (typeof id !== 'string' || !VOICE_ID.test(id)) throw new Error('agent has no voice id');
      return id;
    }).catch(() => {
      config.log({ level: 'warn', msg: 'voiceover: interviewer voice unavailable; using the fallback voice' });
      clipaVoice = undefined;
      clipaFailedAt = config.now();
      return CLIPA_FALLBACK_VOICE;
    });
    return clipaVoice;
  };

  const voiceFor = async (role: VoiceRole): Promise<string> => {
    const override = config.voiceoverVoices[role];
    if (override) return override;
    return role === 'clipa' ? lookupClipaVoice() : DEFAULT_VOICES[role];
  };

  const readCache = async (file: string): Promise<Buffer | null> => {
    const memory = kept.get(file);
    if (memory) return memory;
    try { const b = await readFile(file); return b.length > 0 ? b : null; } catch { return null; }
  };

  const generate = (line: VoiceoverLine, voiceId: string, file: string): Promise<Generated> => serial(async () => {
    const cached = await readCache(file);
    if (cached) return { ok: true, audio: cached };
    const started = Date.now();
    let r: globalThis.Response;
    try {
      r = await config.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: line.text, model_id: VOICEOVER_MODEL }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch { return { ok: false, error: 'elevenlabs_unreachable' }; }
    let audio: Buffer;
    try {
      if (!r.ok) { await r.arrayBuffer().catch(() => {}); return { ok: false, error: 'elevenlabs_error', status: r.status }; }
      audio = Buffer.from(await r.arrayBuffer());
    } catch { return { ok: false, error: 'elevenlabs_unreachable' }; }
    if (audio.length === 0 || audio.length > MAX_AUDIO) return { ok: false, error: 'elevenlabs_error', status: r.status };
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(config.voiceoverDir, { recursive: true });
      await writeFile(tmp, audio);
      await rename(tmp, file);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      kept.set(file, audio);
      config.log({ level: 'warn', msg: 'voiceover: cache write failed; keeping the line in memory', id: line.id });
    }
    config.log({ level: 'info', msg: 'voiceover generated', id: line.id, bytes: audio.length, ms: Date.now() - started });
    return { ok: true, audio };
  });

  const handler = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    const line = LINE_ID.test(id) ? (await loadLines(config.voiceoverLinesFile)).get(id) : undefined;
    if (!line) { res.status(404).set('Cache-Control', 'no-store').json({ ok: false, error: 'unknown_line' }); return; }
    if (!config.elevenLabsApiKey) { res.status(503).set('Cache-Control', 'no-store').json({ ok: false, error: 'elevenlabs_not_configured' }); return; }
    const voiceId = await voiceFor(line.voice);
    const key = createHash('sha256').update(voiceId + VOICEOVER_MODEL + line.text).digest('hex');
    const file = join(config.voiceoverDir, `${key}.mp3`);
    let audio = await readCache(file);
    if (!audio) {
      let job = inflight.get(key);
      if (!job) {
        job = generate(line, voiceId, file).finally(() => { inflight.delete(key); });
        inflight.set(key, job);
      }
      const result = await job;
      if (!result.ok) {
        res.status(502).set('Cache-Control', 'no-store').json({ ok: false, error: result.error, ...(result.status === undefined ? {} : { upstream_status: result.status }) });
        return;
      }
      audio = result.audio;
    }
    res.status(200).set({ 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length), 'Cache-Control': 'public, max-age=300', ETag: `"${key.slice(0, 32)}"` }).end(audio);
  };

  // Mounted under both prefixes, like the admin routes.
  for (const prefix of ['/api/agent/voiceover', '/agent/voiceover']) app.get(`${prefix}/:id`, handler);
}
