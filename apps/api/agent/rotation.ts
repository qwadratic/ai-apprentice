// Disk maintenance for SESSIONS_DIR, ported from infra/placeholder-api: removes orphaned *.tmp files older than
// 10 min, warns above warnBytes, and above rotateBytes deletes the oldest sessions that are older than 24 h
// (down to 75% of the cap). Recent sessions are never deleted; if they alone exceed the cap it only warns.
import type { AgentConfig } from './config.ts';
import type { SessionFiles } from './sessions.ts';

export interface Maintenance {
  /** One full pass now. Never throws. */
  run(): Promise<void>;
  /** Called after a write: runs a pass unless one ran within the last minute. */
  afterWrite(): void;
  /** One pass now, then one every maintenanceIntervalMs (the timer does not keep the process alive). */
  start(): void;
  stop(): void;
}

export function createMaintenance(config: AgentConfig, files: SessionFiles): Maintenance {
  const { limits, log } = config;
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  const run = async (): Promise<void> => {
    const now = config.now();
    lastRun = now;
    try {
      const { sessions, total, tmp } = await files.list();
      let orphans = 0;
      for (const name of tmp) if (await files.removeTmp(name, limits.tmpMaxAgeMs, now)) orphans++;
      if (orphans) log({ level: 'warn', msg: 'sessions orphaned tmp files removed', count: orphans });
      if (total > limits.warnBytes) log({ level: 'warn', msg: 'sessions dir over warn threshold', bytes: total, warn_bytes: limits.warnBytes });
      if (total <= limits.rotateBytes) return;
      const target = 0.75 * limits.rotateBytes;
      let left = total;
      let removed = 0;
      for (const s of [...sessions].reverse()) { // oldest first
        if (left <= target) break;
        if (now - s.mtime < limits.minSessionAgeMs) break; // the rest are newer
        await files.remove(s.id);
        left -= s.size;
        removed++;
      }
      log({ level: 'warn', msg: 'sessions rotated', removed, bytes_before: total, bytes_after: left });
      if (left > limits.rotateBytes) log({ level: 'warn', msg: 'sessions over cap but all remaining are newer than 24 h; nothing deleted', bytes: left });
    } catch {
      log({ level: 'error', msg: 'sessions rotation failed' });
    }
  };
  return {
    run,
    afterWrite() { if (config.now() - lastRun >= 60_000) void run(); },
    start() {
      if (timer) return;
      void run();
      timer = setInterval(() => { void run(); }, limits.maintenanceIntervalMs);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
