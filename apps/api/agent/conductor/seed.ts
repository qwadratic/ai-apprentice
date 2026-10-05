// Seeded "earlier sessions" for the email digital twin demo (docs/pitch/twin-demo.md): two invented confirmed Work Maps that let
// Clipa recognise a process on screen without a rehearsal first. Off unless AGENT_SEED_MAPS=1 (production leaves it unset). They are
// data, not prompts: the fixture is synthetic, labelled so, kept in memory only and loaded only while no confirmed map exists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../config.ts';
import type { MapRegistry } from './engine.ts';
import { parseMapFile } from './map-store.ts';
import type { StoredMap } from './map-store.ts';

/** The fixture: the same JSON shape as the maps file (`confirmed` entries with a session id, a time and the map). */
export const TWIN_SEED_FILE = fileURLToPath(new URL('./seed/twin-sessions.json', import.meta.url));

/** The seed's maps, or none when the file cannot be read or holds no valid map (logged once; nothing throws). */
export function loadSeedMaps(log: Logger, file: string = TWIN_SEED_FILE): StoredMap[] {
  try {
    return parseMapFile(readFileSync(file, 'utf8')).confirmed;
  } catch (err) {
    log({ level: 'warn', msg: 'seed maps file is not readable; no earlier sessions seeded', error: err instanceof Error ? err.name : 'unknown' });
    return [];
  }
}

/** Seeds the registry with the invented earlier sessions when it holds no confirmed map. Returns how many maps were seeded. */
export function seedEarlierSessions(maps: MapRegistry, log: Logger, file: string = TWIN_SEED_FILE): number {
  const seeded = maps.seed(loadSeedMaps(log, file));
  if (seeded > 0) log({ level: 'info', msg: 'seeded invented earlier sessions as confirmed maps (AGENT_SEED_MAPS=1); in memory only', count: seeded });
  return seeded;
}
