// Work Maps on disk (AGENT_MAPS_FILE): atomic writes, read back at start, a size cap that keeps the newest maps, and memory
// only when the path cannot be used. Every test uses its own temp folder; none touches the server's own maps file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MapRegistry } from '../agent/conductor/engine.ts';
import { demoMap } from '../agent/conductor/demo-map.ts';
import { MAP_FILE_VERSION, createMapStore, parseMapFile, serializeMapFile } from '../agent/conductor/map-store.ts';
import type { StoredMap } from '../agent/conductor/map-store.ts';
import type { LogFields } from '../agent/config.ts';
import type { MapSynthesisOutput } from '../agent/llm-tasks.ts';
import { tempDir } from './agent-helpers.ts';

const MAP: MapSynthesisOutput = {
  processes: [{ id: 'p1', title: 'Budget update', summary: 'Keeps the budget in bounds.' }],
  steps: [{ id: 's1', processId: 'p1', kind: 'judgment', goal: 'Keep the budget', action: 'Lowered it to 300', decision: { summary: 'Keep 300', reason: 'sign-off above', quote: 'above 300 the lead signs', quoteAtMs: 5 }, evidenceIds: ['o2'] }],
  guardrails: [{ id: 'g1', processId: 'p1', condition: 'budget above 300', requiredAction: 'ask the lead', reason: 'sign-off', quote: 'above 300 the lead signs', quoteAtMs: 5, escalateTo: 'the lead', exceptions: [], evidenceIds: ['o2'] }],
  gaps: [{ question: 'Who is the lead?', targetId: 'g1', evidenceIds: ['o2'], regionIds: [] }],
  teachBack: 'You keep the budget at 300 and ask the lead above it. Is this right?',
  baselineProvenance: { observations: [{ observationId: 'o2', appId: null, profileId: null, evidenceIds: ['ev-o2'] }], turns: [] },
};
const logs = (): { log: (f: LogFields) => void; lines: LogFields[] } => {
  const lines: LogFields[] = [];
  return { log: (f) => { lines.push(f); }, lines };
};

test('maps are written atomically with mode 0600 and read back at start, so a restart keeps Pass it on and Reflect', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'state', 'maps.json');
  const { log, lines } = logs();
  const store = createMapStore({ file, log });
  assert.equal(store.memoryOnly(), false);
  assert.deepEqual(store.loaded, { confirmed: [], lastBuilt: null }, 'no file yet: an empty store');
  const maps = new MapRegistry(store);
  maps.recordBuilt('sess-a', { ...MAP, comments: [{ targetId: 's1', text: 'only in December', atMs: 7 }] } as never, 1000);
  maps.confirm('sess-a', MAP, 2000);
  maps.confirm('sess-b', { ...MAP, processes: [{ id: 'p1', title: 'Supplier check', summary: '' }] }, 3000);

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, 'state')), ['maps.json'], 'no temp file is left behind');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; confirmed: StoredMap[]; lastBuilt: StoredMap };
  assert.equal(raw.version, MAP_FILE_VERSION);
  assert.deepEqual(raw.confirmed.map((e) => [e.sessionId, e.atMs, e.title]), [['sess-b', 3000, 'Supplier check'], ['sess-a', 2000, 'Budget update']], 'newest first');
  assert.equal(raw.lastBuilt.sessionId, 'sess-a');
  assert.ok(!readFileSync(file, 'utf8').includes('baselineProvenance'), 'only the decoded workflow is stored');

  // The API restarts: a new registry reads the same file.
  const again = new MapRegistry(createMapStore({ file, log }));
  assert.equal(again.find(null)?.sessionId, 'sess-b', 'the newest confirmed map is the latest again');
  assert.equal(again.find('sess-a')?.map.steps[0]?.action, 'Lowered it to 300');
  assert.deepEqual(again.library().map((p) => p.title), ['Supplier check', 'Budget update']);
  assert.equal(again.lastBuilt()?.sessionId, 'sess-a');
  assert.deepEqual((again.lastBuilt()?.map as unknown as { comments: unknown }).comments, [{ targetId: 's1', text: 'only in December', atMs: 7 }]);
  assert.equal(lines.length, 0, 'nothing to warn about');
});

test('the size cap leaves out the oldest confirmed maps first and keeps the newest', () => {
  const entry = (n: number): StoredMap => ({ sessionId: `sess-${n}`, atMs: n, title: `Map ${n}`, map: demoMap() });
  const state = { confirmed: [1, 2, 3, 4, 5].map(entry), lastBuilt: entry(6) };
  const full = serializeMapFile(state, 10 * 1024 * 1024);
  assert.ok(full !== null);
  const one = Buffer.byteLength(JSON.stringify(entry(1)));
  const cap = Buffer.byteLength(full) - 2 * one; // room for all but about two entries
  const text = serializeMapFile(state, cap);
  assert.ok(text !== null && Buffer.byteLength(text) <= cap);
  const kept = parseMapFile(text);
  assert.deepEqual(kept.confirmed.map((e) => e.sessionId), ['sess-5', 'sess-4', 'sess-3']);
  assert.equal(kept.lastBuilt?.sessionId, 'sess-6');
  // Too small even for the last built map: an empty state still fits; below that nothing is written.
  assert.deepEqual(parseMapFile(serializeMapFile(state, 200)!), { confirmed: [], lastBuilt: null });
  assert.equal(serializeMapFile(state, 10), null);
});

test('an unusable path keeps maps in memory only and logs once; an empty path is memory only without a warning', async (t) => {
  const dir = await tempDir(t);
  const blocker = join(dir, 'not-a-folder');
  writeFileSync(blocker, 'x');
  const { log, lines } = logs();
  const store = createMapStore({ file: join(blocker, 'maps.json'), log });
  const maps = new MapRegistry(store);
  maps.confirm('sess-a', MAP, 1);
  maps.recordBuilt('sess-a', MAP, 2);
  assert.equal(store.memoryOnly(), true);
  assert.equal(lines.length, 1, 'logged once');
  assert.equal(lines[0]?.level, 'warn');
  assert.equal(maps.find(null)?.sessionId, 'sess-a', 'the registry still works from memory');
  assert.equal(maps.lastBuilt()?.sessionId, 'sess-a');

  const off = logs();
  const memory = createMapStore({ file: '', log: off.log });
  memory.save({ confirmed: [], lastBuilt: null });
  assert.equal(memory.memoryOnly(), true);
  assert.equal(off.lines.length, 0);
});

test('a damaged file starts empty and is replaced by the next write; entries that are not maps are left out', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'maps.json');
  writeFileSync(file, '{"version":1,"confirmed":[');
  const { log, lines } = logs();
  const store = createMapStore({ file, log });
  assert.deepEqual(store.loaded, { confirmed: [], lastBuilt: null });
  assert.equal(lines.length, 1);
  new MapRegistry(store).confirm('sess-a', MAP, 1);
  assert.equal(createMapStore({ file, log }).loaded.confirmed[0]?.sessionId, 'sess-a');

  writeFileSync(file, JSON.stringify({ version: 1, lastBuilt: { sessionId: 'x', atMs: 1, title: 't', map: { steps: 'no' } }, confirmed: [{ sessionId: 'ok', atMs: 2, title: 'Fine', map: MAP }, null] }));
  const mixed = createMapStore({ file, log }).loaded;
  assert.deepEqual([mixed.confirmed.map((e) => e.sessionId), mixed.lastBuilt], [['ok'], null]);
});
