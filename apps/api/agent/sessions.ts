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
const SESSION_FILE = new RegExp(`^([A-Za-z0-9-]{8,64})\\.(jsonl|conv|elevenlabs\\.json|${AUDIO_EXTS.join('|')})$`);

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

export interface SessionInfo { id: string; size: number; mtime: number; hasEvents: boolean; hasTranscript: boolean; hasAudio: boolean }
export interface SessionDump { conversationId: string | null; events: unknown[] | null; transcript: unknown; audio: { ext: string; bytes: number } | null }

export interface SessionFiles {
  eventsSize(id: string): Promise<number>;
  appendEvents(id: string, lines: string): Promise<void>;
  /** Everything stored for one session, or null when nothing is. */
  dump(id: string): Promise<SessionDump | null>;
  /** Stored sessions, newest first, with the total bytes and the orphaned *.tmp file names. */
  list(): Promise<{ sessions: SessionInfo[]; total: number; tmp: string[] }>;
  remove(id: string): Promise<void>;
  removeTmp(name: string, olderThanMs: number, now: number): Promise<boolean>;
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
  const boundConversation = async (id: string): Promise<string | null> => {
    try { return (await fsp.readFile(file(id, 'conv'), 'utf8')).trim(); } catch { return null; }
  };
  const hasAudio = async (id: string): Promise<boolean> => {
    for (const ext of AUDIO_EXTS) if (await size(file(id, ext))) return true;
    return false;
  };
  return {
    eventsSize: (id) => size(file(id, 'jsonl')),
    async appendEvents(id, lines) {
      await ensureDir();
      await fsp.appendFile(file(id, 'jsonl'), lines, { mode: 0o640 });
    },
    async dump(id) {
      let events: unknown[] | null = null;
      try { events = (await fsp.readFile(file(id, 'jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown); } catch { /* none or unreadable */ }
      const transcript = await readJson(file(id, 'elevenlabs.json'));
      let audio: SessionDump['audio'] = null;
      for (const ext of AUDIO_EXTS) { const bytes = await size(file(id, ext)); if (bytes) { audio = { ext, bytes }; break; } }
      const conversationId = await boundConversation(id);
      return events === null && transcript === null && !audio && !conversationId ? null : { conversationId, events, transcript, audio };
    },
    async list() {
      const byId = new Map<string, SessionInfo>();
      const tmp: string[] = [];
      let total = 0;
      let names: string[] = [];
      try { names = await fsp.readdir(dir); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
      for (const name of names) {
        if (name.endsWith('.tmp')) { tmp.push(name); continue; }
        const m = SESSION_FILE.exec(name);
        const id = m?.[1];
        const kind = m?.[2];
        if (!id || !kind) continue;
        const st = await fsp.stat(join(dir, name));
        total += st.size;
        const info = byId.get(id) ?? { id, size: 0, mtime: 0, hasEvents: false, hasTranscript: false, hasAudio: false };
        info.size += st.size;
        info.mtime = Math.max(info.mtime, st.mtimeMs);
        if (kind === 'jsonl') info.hasEvents = true;
        if (kind === 'elevenlabs.json') info.hasTranscript = true;
        if (AUDIO_EXTS.includes(kind)) info.hasAudio = true;
        byId.set(id, info);
      }
      return { sessions: [...byId.values()].sort((a, b) => b.mtime - a.mtime), total, tmp };
    },
    async remove(id) {
      for (const ext of ['jsonl', 'conv', 'elevenlabs.json', ...AUDIO_EXTS]) await fsp.rm(file(id, ext), { force: true });
    },
    async removeTmp(name, olderThanMs, now) {
      const path = join(dir, name);
      const st = await fsp.stat(path).catch(() => null);
      if (!st || now - st.mtimeMs <= olderThanMs) return false;
      await fsp.rm(path, { force: true });
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
    boundConversation,
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
