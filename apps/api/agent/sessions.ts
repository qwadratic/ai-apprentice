// Per-session files in SESSIONS_DIR, same layout as infra/placeholder-api so the lab data stays readable:
// {id}.jsonl (events), {id}.conv (bound conversationId), {id}.elevenlabs.json (transcript), {id}.{mp3,wav,...} (audio).
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './config.ts';
import type { Json } from './config.ts';

export interface SessionEvent { t: number; dir: string; type: string; text: string }
export type ParsedEvents =
  | { ok: false; error: string; field?: string }
  | { ok: true; conversationId: string | undefined; events: SessionEvent[] };

export const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_DIRS = new Set<string>(['sent', 'recv', 'sys', 'err']);
export const AUDIO_EXT: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
};
const AUDIO_EXTS = [...new Set(Object.values(AUDIO_EXT))];

const errCode = (e: unknown): unknown => (isRecord(e) ? e.code : undefined);

export function parseEvents(body: unknown): ParsedEvents {
  if (!isRecord(body) || !Array.isArray(body.events) || body.events.length === 0) return { ok: false, error: 'invalid_body', field: 'events' };
  const conversationId = body.conversationId;
  if (conversationId !== undefined && (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId))) {
    return { ok: false, error: 'invalid_body', field: 'conversationId' };
  }
  const events: SessionEvent[] = [];
  for (const [i, e] of (body.events as unknown[]).entries()) {
    if (!isRecord(e)) return { ok: false, error: 'invalid_body', field: `events.${i}` };
    const { t, dir, type, text } = e;
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof dir !== 'string' || !EVENT_DIRS.has(dir) || typeof type !== 'string' || typeof text !== 'string') {
      return { ok: false, error: 'invalid_body', field: `events.${i}` };
    }
    events.push({ t, dir, type, text });
  }
  return { ok: true, conversationId: conversationId as string | undefined, events };
}

export interface SessionFiles {
  /** Appends lines to {id}.jsonl; false when the session file would exceed its cap. */
  appendEvents(id: string, lines: string, maxFileBytes: number): Promise<boolean>;
  /** Binds the session to its first conversationId; false when it is bound to another one. */
  bindConversation(id: string, conversationId: string): Promise<boolean>;
  boundConversation(id: string): Promise<string | null>;
  readTranscript(id: string): Promise<unknown>;
  /** Stores a transcript unless a finished one is already there; true when written. */
  storeTranscript(id: string, conv: Json): Promise<boolean>;
  hasAudio(id: string): Promise<boolean>;
  /** Writes audio once, never overwriting; false when audio already existed. */
  storeAudio(id: string, ext: string, bytes: Buffer): Promise<boolean>;
}

export function createSessionFiles(dir: string): SessionFiles {
  const file = (id: string, ext: string): string => join(dir, `${id}.${ext}`);
  const ensureDir = (): Promise<string | undefined> => fsp.mkdir(dir, { recursive: true, mode: 0o750 });
  const size = async (path: string): Promise<number> => { try { return (await fsp.stat(path)).size; } catch { return 0; } };
  const readJson = async (path: string): Promise<unknown> => { try { return JSON.parse(await fsp.readFile(path, 'utf8')); } catch { return null; } };
  const writeAtomic = async (path: string, data: string): Promise<void> => {
    const tmp = `${path}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, data, { mode: 0o640 });
    await fsp.rename(tmp, path);
  };
  const hasAudio = async (id: string): Promise<boolean> => {
    for (const ext of AUDIO_EXTS) if (await size(file(id, ext))) return true;
    return false;
  };
  return {
    async appendEvents(id, lines, maxFileBytes) {
      await ensureDir();
      const path = file(id, 'jsonl');
      if ((await size(path)) + Buffer.byteLength(lines) > maxFileBytes) return false;
      await fsp.appendFile(path, lines, { mode: 0o640 });
      return true;
    },
    async bindConversation(id, conversationId) {
      await ensureDir();
      const path = file(id, 'conv');
      try {
        await fsp.writeFile(path, conversationId, { flag: 'wx', mode: 0o640 });
        return true;
      } catch (e) {
        if (errCode(e) !== 'EEXIST') throw e;
        return (await fsp.readFile(path, 'utf8')).trim() === conversationId;
      }
    },
    async boundConversation(id) {
      try { return (await fsp.readFile(file(id, 'conv'), 'utf8')).trim(); } catch { return null; }
    },
    readTranscript: (id) => readJson(file(id, 'elevenlabs.json')),
    async storeTranscript(id, conv) {
      await ensureDir();
      const existing = await readJson(file(id, 'elevenlabs.json'));
      if (isRecord(existing) && existing.status === 'done') return false;
      await writeAtomic(file(id, 'elevenlabs.json'), JSON.stringify(conv));
      return true;
    },
    hasAudio,
    async storeAudio(id, ext, bytes) {
      await ensureDir();
      if (await hasAudio(id)) return false;
      const path = file(id, ext);
      const tmp = `${path}.${randomUUID()}.tmp`;
      await fsp.writeFile(tmp, bytes, { mode: 0o640 });
      try { await fsp.link(tmp, path); } // fails if the file appeared meanwhile: never overwrite
      catch (e) { if (errCode(e) !== 'EEXIST') throw e; return false; }
      finally { await fsp.rm(tmp, { force: true }); }
      return true;
    },
  };
}
