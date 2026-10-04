// Work Maps on disk, so a deploy, an API restart or a page reload does not wipe what Clipa learned (Reflect and Pass it on).
// One small JSON file (AGENT_MAPS_FILE): the confirmed maps of the MapRegistry plus the last map built in any session.
// Written whole on every change, atomically (a temp file, then rename), mode 0600: maps hold the expert's words. Never raw
// frames or audio: only the map JSON. When the file cannot be read or written, the store logs once and keeps maps in memory.
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from '../config.ts';
import type { Logger } from '../config.ts';
import type { MapSynthesisOutput } from '../llm-tasks.ts';

/** One map as the file keeps it: whose session, when (server epoch ms), a short title for a listing, and the map itself. */
export interface StoredMap { sessionId: string; atMs: number; title: string; map: MapSynthesisOutput }
export interface MapStoreState {
  /** Confirmed maps, any order; the file keeps the newest first. */
  confirmed: StoredMap[];
  /** The newest map built from a session's own screen and words, confirmed or not. */
  lastBuilt: StoredMap | null;
}

export const MAP_FILE_VERSION = 1;
/** The file stays below this; the oldest confirmed maps are left out first. */
export const MAP_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** At most this many confirmed maps are kept (Teach reads the newest six). */
export const MAP_FILE_MAX_CONFIRMED = 50;

export interface MapStore {
  /** What the file held at start: empty when there was none, it could not be read, or the store is memory-only. */
  readonly loaded: MapStoreState;
  /** Writes the whole state; a no-op once the store is memory-only. */
  save(state: MapStoreState): void;
  /** True when maps are not written to disk (no path, or the path could not be read or written). */
  memoryOnly(): boolean;
}

export interface MapStoreOptions {
  /** The JSON file; '' keeps maps in memory only. */
  file: string;
  log: Logger;
  maxBytes?: number;
}

const empty = (): MapStoreState => ({ confirmed: [], lastBuilt: null });
const errorCode = (err: unknown): string => (isRecord(err) && typeof err.code === 'string' ? err.code : err instanceof Error ? err.name : 'unknown');

/** A short title for a map: its first process, else its first step's goal. */
export function mapTitle(map: MapSynthesisOutput): string {
  const title = map.processes?.[0]?.title ?? map.steps[0]?.goal ?? 'Work Map';
  return title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Work Map';
}

/** The map without the server's baseline bookkeeping (observation and app ids): the file keeps the decoded workflow only. */
export function storableMap(map: MapSynthesisOutput): MapSynthesisOutput {
  const copy = structuredClone(map);
  delete copy.baselineProvenance;
  return copy;
}

const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Enough of the map shape that the registry, the library and Reflect can read it; anything else is left out on load. */
function isMap(v: unknown): v is MapSynthesisOutput {
  if (!isRecord(v) || typeof v.teachBack !== 'string') return false;
  if (!Array.isArray(v.steps) || !Array.isArray(v.guardrails) || !Array.isArray(v.gaps)) return false;
  if (v.processes !== undefined && !(Array.isArray(v.processes) && v.processes.every((p) => isRecord(p) && typeof p.id === 'string' && typeof p.title === 'string'))) return false;
  return v.steps.every((s) => isRecord(s) && typeof s.id === 'string' && typeof s.action === 'string' && typeof s.goal === 'string' && strings(s.evidenceIds))
    && v.guardrails.every((g) => isRecord(g) && typeof g.id === 'string' && typeof g.condition === 'string' && typeof g.requiredAction === 'string' && strings(g.evidenceIds) && strings(g.exceptions))
    && v.gaps.every((g) => isRecord(g) && typeof g.question === 'string' && strings(g.evidenceIds) && strings(g.regionIds));
}

function readEntry(v: unknown): StoredMap | null {
  if (!isRecord(v) || typeof v.sessionId !== 'string' || v.sessionId === '' || typeof v.atMs !== 'number' || !Number.isFinite(v.atMs)) return null;
  if (!isMap(v.map)) return null;
  const map = { ...v.map, processes: Array.isArray(v.map.processes) ? v.map.processes : [] };
  return { sessionId: v.sessionId.slice(0, 64), atMs: v.atMs, title: typeof v.title === 'string' ? v.title.slice(0, 120) : mapTitle(map), map };
}

/** Parses the file's JSON; entries that do not read as maps are dropped. */
export function parseMapFile(text: string): MapStoreState {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error('not an object');
  const confirmed = Array.isArray(raw.confirmed) ? raw.confirmed.map(readEntry).filter((e): e is StoredMap => e !== null) : [];
  return { confirmed, lastBuilt: readEntry(raw.lastBuilt) };
}

/**
 * The file's JSON: `{version, lastBuilt, confirmed}`, confirmed newest first. Under `maxBytes` it leaves out the oldest
 * confirmed maps first, then the last built one; null when even an empty state would not fit.
 */
export function serializeMapFile(state: MapStoreState, maxBytes = MAP_FILE_MAX_BYTES): string | null {
  const confirmed = [...state.confirmed].sort((a, b) => b.atMs - a.atMs).slice(0, MAP_FILE_MAX_CONFIRMED).map((e) => JSON.stringify(e));
  let lastBuilt = state.lastBuilt === null ? 'null' : JSON.stringify(state.lastBuilt);
  const build = (): string => `{"version":${MAP_FILE_VERSION},"lastBuilt":${lastBuilt},"confirmed":[${confirmed.join(',')}]}`;
  let bytes = Buffer.byteLength(build());
  while (bytes > maxBytes && confirmed.length > 0) {
    const dropped = confirmed.pop()!;
    bytes -= Buffer.byteLength(dropped) + (confirmed.length > 0 ? 1 : 0); // the entry and its comma
  }
  if (bytes > maxBytes) lastBuilt = 'null';
  const text = build();
  return Buffer.byteLength(text) <= maxBytes ? text : null;
}

/** Opens the store: reads the file once (a missing file is an empty store) and checks that its folder is writable. */
export function createMapStore(options: MapStoreOptions): MapStore {
  const { file, log } = options;
  const maxBytes = options.maxBytes ?? MAP_FILE_MAX_BYTES;
  let memoryOnly = file === '';
  let warned = false;
  const giveUp = (msg: string, err: unknown): void => {
    memoryOnly = true;
    if (warned) return;
    warned = true;
    log({ level: 'warn', msg, file, error: errorCode(err) });
  };
  let loaded = empty();
  if (!memoryOnly) {
    try {
      loaded = parseMapFile(readFileSync(file, 'utf8'));
    } catch (err) {
      if (errorCode(err) === 'ENOENT') { /* no maps yet */ }
      else if (err instanceof SyntaxError || (err instanceof Error && err.message === 'not an object')) {
        // A damaged file: start empty; the next change writes a good one over it.
        warned = true;
        log({ level: 'warn', msg: 'maps file is not valid JSON; starting with no stored maps', file });
      } else giveUp('maps file is not readable; Work Maps stay in memory only', err);
    }
  }
  if (!memoryOnly) {
    // A folder that exists must be writable now; a missing one is created on the first write.
    const dir = dirname(file);
    try { if (existsSync(dir)) accessSync(dir, constants.W_OK); } catch (err) { giveUp('maps folder is not writable; Work Maps stay in memory only', err); }
  }
  return {
    loaded,
    memoryOnly: () => memoryOnly,
    save(state) {
      if (memoryOnly) return;
      const text = serializeMapFile(state, maxBytes);
      if (text === null) { giveUp('maps do not fit the size cap; Work Maps stay in memory only', new Error('too_large')); return; }
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      let fd: number | null = null;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
        fd = openSync(tmp, 'w', 0o600);
        writeSync(fd, text);
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        renameSync(tmp, file);
      } catch (err) {
        if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
        try { unlinkSync(tmp); } catch { /* never created */ }
        giveUp('maps file is not writable; Work Maps stay in memory only', err);
      }
    },
  };
}
