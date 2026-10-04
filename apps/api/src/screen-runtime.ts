import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseScreenObservation, parseScreenStatus} from '@apprentice/contracts';
import {ScreenSessionHub, createFileEvidenceStore, createRunnerClient, createScreenService, parseVisionFrames} from '../screen/index.ts';
import type {EvidenceMetadataRepository, ScreenEvidenceRecord, ScreenEvidenceStore, VisionRunner} from '../screen/index.ts';

export interface ScreenRuntimeOptions {
  readonly databasePath: string;
  readonly mediaDir: string;
  readonly runner?: VisionRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
}
export interface ScreenRuntime { readonly hub: ScreenSessionHub; readonly evidence: ScreenEvidenceStore; close(): void }

export function createScreenRuntime(options: ScreenRuntimeOptions): ScreenRuntime {
  assertAbsolutePath('DATABASE_PATH', options.databasePath);
  assertAbsolutePath('MEDIA_DIR', options.mediaDir);
  const database = new DatabaseSync(options.databasePath);
  database.exec('CREATE TABLE IF NOT EXISTS screen_evidence (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT');
  const evidence = createFileEvidenceStore({mediaDir: options.mediaDir, metadata: createSqliteEvidenceMetadata(database)});
  const runner = options.runner ?? createRunnerClient({env: options.env});
  // VISION_GENERIC=off reads a frame with no known surface as before screen_activity (workspace kinds only).
  const genericVision = options.env?.VISION_GENERIC !== 'off';
  // VISION_FRAMES: recent frames per generic vision call, the analysed one last (1..4, default 3; 1 = one frame as before).
  const storyboard = {frames: parseVisionFrames(options.env?.VISION_FRAMES)};
  const hub = new ScreenSessionHub(({publish, onEvent}) => createScreenService({
    runner, evidence, publish, onEvent, parseObservation: parseScreenObservation, genericVision, storyboard,
  }), parseScreenStatus);
  return {hub, evidence, close: () => database.close()};
}

export function createSqliteEvidenceMetadata(database: DatabaseSync): EvidenceMetadataRepository {
  const put = database.prepare('INSERT INTO screen_evidence (id, record_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json');
  const get = database.prepare('SELECT record_json FROM screen_evidence WHERE id = ?');
  const remove = database.prepare('DELETE FROM screen_evidence WHERE id = ?');
  return {
    async put(record) { put.run(record.id, JSON.stringify(record)); },
    async get(id) {
      const row = get.get(id) as {record_json?: unknown} | undefined;
      if (!row || typeof row.record_json !== 'string') return undefined;
      try { return JSON.parse(row.record_json) as ScreenEvidenceRecord; } catch { return undefined; }
    },
    async remove(id) { remove.run(id); },
  };
}

function assertAbsolutePath(name: string, value: string): void {
  if (!value || !path.isAbsolute(value)) throw new TypeError(`An absolute ${name} is required`);
}
