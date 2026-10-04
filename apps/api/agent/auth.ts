// Session tokens: only sha256(token) is stored, in one JSON file so a restart keeps live sessions.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig } from './config.ts';
import { isRecord } from './config.ts';

export interface SessionRecord { sessionId: string; tokenHash: string; createdAt: number; expiresAt: number }
export interface IssuedSession { sessionId: string; sessionEpochMs: number; token: string }
export type AuthResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'forbidden' };
export interface SessionStore {
  issue(): Promise<IssuedSession>;
  /** `authorization` is the raw header value. With a sessionId the token must belong to that session. */
  check(authorization: string | null | undefined, sessionId: string | null): AuthResult;
}

const FILE_NAME = 'agent-sessions.json';
const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();
const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

export function bearerToken(authorization: string | null | undefined): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(authorization ?? '');
  return m?.[1] ?? null;
}

function parseRecords(raw: string): SessionRecord[] {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || !Array.isArray(data.sessions)) return [];
  const out: SessionRecord[] = [];
  for (const s of data.sessions as unknown[]) {
    if (isRecord(s) && typeof s.sessionId === 'string' && isHex64(s.tokenHash) && typeof s.createdAt === 'number' && typeof s.expiresAt === 'number') {
      out.push({ sessionId: s.sessionId, tokenHash: s.tokenHash, createdAt: s.createdAt, expiresAt: s.expiresAt });
    }
  }
  return out;
}

export function createSessionStore(config: Pick<AgentConfig, 'sessionsDir' | 'sessionTtlMs' | 'now' | 'log'> & { maxLive: number }): SessionStore {
  const path = join(config.sessionsDir, FILE_NAME);
  const sessions = new Map<string, SessionRecord>();
  try {
    for (const r of parseRecords(readFileSync(path, 'utf8'))) if (r.expiresAt > config.now()) sessions.set(r.sessionId, r);
  } catch (error) {
    // A missing file is the first start; anything else is reported once and the store starts empty.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') config.log({ level: 'warn', msg: 'agent session file unreadable; starting empty' });
  }

  let writing: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const snapshot = JSON.stringify({ version: 1, sessions: [...sessions.values()] });
    const run = async (): Promise<void> => {
      mkdirSync(config.sessionsDir, { recursive: true, mode: 0o750 });
      const tmp = `${path}.${randomUUID()}.tmp`;
      await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
      await fsp.rename(tmp, path);
    };
    writing = writing.then(run, run);
    return writing;
  };

  const live = (r: SessionRecord): boolean => r.expiresAt > config.now();
  const sameHash = (r: SessionRecord, h: Buffer): boolean => timingSafeEqual(Buffer.from(r.tokenHash, 'hex'), h);

  return {
    async issue() {
      const now = config.now();
      for (const [id, r] of sessions) if (r.expiresAt <= now) sessions.delete(id);
      while (sessions.size >= config.maxLive) {
        const oldest = sessions.keys().next().value; // insertion order = creation order
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      const token = randomBytes(32).toString('base64url');
      const record: SessionRecord = { sessionId: randomUUID(), tokenHash: hashToken(token).toString('hex'), createdAt: now, expiresAt: now + config.sessionTtlMs };
      sessions.set(record.sessionId, record);
      try { await persist(); } catch (error) { sessions.delete(record.sessionId); throw error; }
      return { sessionId: record.sessionId, sessionEpochMs: now, token };
    },
    check(authorization, sessionId) {
      const token = bearerToken(authorization);
      if (!token) return { ok: false, reason: 'missing' };
      const h = hashToken(token);
      if (sessionId !== null) {
        const r = sessions.get(sessionId);
        if (r && live(r) && sameHash(r, h)) return { ok: true, sessionId };
        // A token that is valid for another live session is forbidden here, not unknown.
        for (const o of sessions.values()) if (live(o) && sameHash(o, h)) return { ok: false, reason: 'forbidden' };
        return { ok: false, reason: 'invalid' };
      }
      let found: string | null = null;
      for (const o of sessions.values()) if (live(o) && sameHash(o, h) && found === null) found = o.sessionId;
      return found === null ? { ok: false, reason: 'invalid' } : { ok: true, sessionId: found };
    },
  };
}
