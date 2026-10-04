import {mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {RecordingSegment} from '../../../../packages/screen/evidence/index.ts';

export type RecordingAsset = Readonly<{
  assetRef: string; sessionId: string; assetId: string; mimeType: string; byteLength: number; chunkCount: number;
  segment?: RecordingSegment;
}>;

export type RecordingStoreErrorCode = 'asset_not_found' | 'chunk_conflict' | 'chunk_out_of_order' |
  'finalization_incomplete' | 'storage_failed' | 'quota_exceeded' | 'storage_full';

export class RecordingStoreError extends Error {
  readonly code: RecordingStoreErrorCode;
  constructor(code: RecordingStoreErrorCode, options?: ErrorOptions) {
    super(code, options); this.name = 'RecordingStoreError';
    this.code = code;
  }
}

export interface RecordingStore {
  append(sessionId: string, assetId: string, index: number, mimeType: string, bytes: Uint8Array): Promise<'created' | 'duplicate'>;
  finalize(sessionId: string, assetId: string, chunkCount: number, mimeType: string,
    segment?: RecordingSegment): Promise<{asset: RecordingAsset; created: boolean}>;
  read(sessionId: string, assetId: string): Promise<{asset: RecordingAsset; bytes: Uint8Array}>;
}

type Pending = {sessionId: string; assetId: string; mimeType: string; chunkCount: number; byteLength: number};

export interface RecordingStoreOptions {
  readonly maxAssetBytes?: number;
  /** Bytes one session may hold in all its recordings, pending and final. */
  readonly maxSessionBytes?: number;
  /** Recordings one session may start. */
  readonly maxSessionAssets?: number;
  /** Free space the disk keeps: a chunk that would leave less is refused. */
  readonly minFreeBytes?: number;
  /** Free bytes on the volume of `root`; injected for tests. */
  readonly freeBytes?: (root: string) => Promise<number>;
}

const diskFree = async (root: string): Promise<number> => {
  const s = await statfs(root);
  return Number(s.bavail) * Number(s.bsize);
};

export function createFileRecordingStore(root: string, options: RecordingStoreOptions = {}): RecordingStore {
  if (!path.isAbsolute(root)) throw new TypeError('Recording storage root must be absolute.');
  const maxAssetBytes = options.maxAssetBytes ?? 256_000_000;
  const maxSessionBytes = options.maxSessionBytes ?? 1_000_000_000;
  const maxSessionAssets = options.maxSessionAssets ?? 200;
  const minFreeBytes = options.minFreeBytes ?? 1_000_000_000;
  const freeBytes = options.freeBytes ?? diskFree;
  for (const limit of [maxAssetBytes, maxSessionBytes, maxSessionAssets]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Recording limits required.');
  }
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw new TypeError('Recording limits required.');
  const locks = new Map<string, Promise<unknown>>();
  const location = (sessionId: string, assetId: string) => path.join(root, sessionId, assetId);
  const locked = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    locks.set(key, current);
    try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  };
  const loadFinal = async (directory: string): Promise<RecordingAsset | undefined> => {
    try { return JSON.parse(await readFile(path.join(directory, 'asset.json'), 'utf8')) as RecordingAsset; }
    catch (error: unknown) { if (isMissing(error)) return undefined; throw storage(error); }
  };
  const loadPending = async (directory: string): Promise<Pending | undefined> => {
    try { return JSON.parse(await readFile(path.join(directory, 'pending.json'), 'utf8')) as Pending; }
    catch (error: unknown) { if (isMissing(error)) return undefined; throw storage(error); }
  };
  /** Bytes and recordings this session already holds, pending and final. */
  const sessionUsage = async (sessionId: string): Promise<{bytes: number; assets: number}> => {
    let names: string[];
    try { names = await readdir(path.join(root, sessionId)); }
    catch (error: unknown) { if (isMissing(error)) return {bytes: 0, assets: 0}; throw storage(error); }
    let bytes = 0; let assets = 0;
    for (const name of names) {
      const directory = path.join(root, sessionId, name);
      const entry = await loadFinal(directory) ?? await loadPending(directory);
      if (!entry) continue;
      assets += 1; bytes += Number.isSafeInteger(entry.byteLength) ? entry.byteLength : 0;
    }
    return {bytes, assets};
  };
  return {
    async append(sessionId, assetId, index, mimeType, bytes) {
      validateInput(sessionId, assetId, mimeType);
      if (!Number.isSafeInteger(index) || index < 0 || !(bytes instanceof Uint8Array) || !bytes.byteLength) throw new TypeError('Invalid recording chunk.');
      const key = `${sessionId}/${assetId}`;
      // The session lock makes the quota check and the write one step for all of a session's recordings.
      return locked(`session:${sessionId}`, () => locked(key, async () => {
        const directory = location(sessionId, assetId);
        try {
          if (await loadFinal(directory)) throw new RecordingStoreError('chunk_conflict');
          let pending = await loadPending(directory);
          if (!pending) {
            if (index !== 0) throw new RecordingStoreError('chunk_out_of_order');
            pending = {sessionId, assetId, mimeType, chunkCount: 0, byteLength: 0};
          }
          if (pending.mimeType !== mimeType) throw new RecordingStoreError('chunk_conflict');
          if (index < pending.chunkCount) {
            const existing = await readFile(path.join(directory, `${index}.chunk`));
            if (existing.length === bytes.byteLength && existing.equals(bytes)) return 'duplicate';
            throw new RecordingStoreError('chunk_conflict');
          }
          if (index !== pending.chunkCount) throw new RecordingStoreError('chunk_out_of_order');
          if (pending.byteLength + bytes.byteLength > maxAssetBytes) throw new RecordingStoreError('quota_exceeded');
          const usage = await sessionUsage(sessionId);
          if (index === 0 && usage.assets >= maxSessionAssets) throw new RecordingStoreError('quota_exceeded');
          if (usage.bytes + bytes.byteLength > maxSessionBytes) throw new RecordingStoreError('quota_exceeded');
          await mkdir(directory, {recursive: true});
          if (await freeBytes(root) - bytes.byteLength < minFreeBytes) throw new RecordingStoreError('storage_full');
          const chunkPath = path.join(directory, `${index}.chunk`);
          await writeFile(chunkPath, bytes, {flag: 'wx'});
          try { await atomicJson(directory, 'pending.json', {...pending,
            chunkCount: pending.chunkCount + 1, byteLength: pending.byteLength + bytes.byteLength}); }
          catch (error: unknown) { await rm(chunkPath, {force: true}).catch(() => undefined); throw error; }
          return 'created';
        } catch (error: unknown) { if (error instanceof RecordingStoreError) throw error; throw storage(error); }
      }));
    },
    async finalize(sessionId, assetId, chunkCount, mimeType, segment) {
      validateInput(sessionId, assetId, mimeType);
      if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) throw new TypeError('Invalid chunk count.');
      if (segment !== undefined) validateSegment(segment, sessionId, assetId, mimeType);
      const key = `${sessionId}/${assetId}`;
      return locked(key, async () => {
        const directory = location(sessionId, assetId);
        try {
          const existing = await loadFinal(directory);
          if (existing) {
            if (existing.chunkCount !== chunkCount || existing.mimeType !== mimeType ||
              JSON.stringify(existing.segment) !== JSON.stringify(segment)) throw new RecordingStoreError('chunk_conflict');
            return {asset: existing, created: false};
          }
          const pending = await loadPending(directory);
          if (!pending || pending.chunkCount !== chunkCount || pending.mimeType !== mimeType || chunkCount < 1) {
            throw new RecordingStoreError('finalization_incomplete');
          }
          const temporary = path.join(directory, 'asset.partial');
          const handle = await open(temporary, 'w');
          try { for (let index = 0; index < chunkCount; index += 1) await handle.writeFile(await readFile(path.join(directory, `${index}.chunk`))); }
          finally { await handle.close(); }
          const actual = (await stat(temporary)).size;
          if (actual !== pending.byteLength) throw new RecordingStoreError('storage_failed');
          await rename(temporary, path.join(directory, 'asset.bin'));
          const asset = Object.freeze({assetRef: `recording:${sessionId}:${assetId}`, sessionId, assetId, mimeType,
            byteLength: actual, chunkCount, ...(segment === undefined ? {} : {segment: Object.freeze({...segment})})});
          await atomicJson(directory, 'asset.json', asset, true);
          await Promise.all(Array.from({length: chunkCount}, (_, index) => rm(path.join(directory, `${index}.chunk`), {force: true}).catch(() => undefined)));
          await rm(path.join(directory, 'pending.json'), {force: true}).catch(() => undefined);
          return {asset, created: true};
        } catch (error: unknown) { if (error instanceof RecordingStoreError) throw error; throw storage(error); }
      });
    },
    async read(sessionId, assetId) {
      validateInput(sessionId, assetId);
      const directory = location(sessionId, assetId);
      try {
        const asset = await loadFinal(directory);
        if (!asset || asset.sessionId !== sessionId || asset.assetId !== assetId || asset.assetRef !== `recording:${sessionId}:${assetId}` ||
          !supportedMime(asset.mimeType) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 ||
          !Number.isSafeInteger(asset.chunkCount) || asset.chunkCount < 1) throw new RecordingStoreError('asset_not_found');
        const bytes = await readFile(path.join(directory, 'asset.bin'));
        if (bytes.byteLength !== asset.byteLength) throw new RecordingStoreError('storage_failed');
        return {asset, bytes};
      } catch (error: unknown) { if (error instanceof RecordingStoreError) throw error; throw storage(error); }
    },
  };
}

function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function storage(cause: unknown): RecordingStoreError { return new RecordingStoreError('storage_failed', {cause}); }
function validateInput(sessionId: string, assetId: string, mimeType?: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId) ||
    (mimeType !== undefined && !supportedMime(mimeType))) throw new TypeError('Invalid recording identity or media type.');
}
function supportedMime(value: string): boolean { return /^video\/(?:webm|mp4)(?:;codecs=[a-z0-9.,-]+)?$/.test(value); }
function validateSegment(segment: RecordingSegment, sessionId: string, assetId: string, mimeType: string): void {
  if (!segment || typeof segment !== 'object' || segment.id !== assetId || segment.sessionId !== sessionId ||
    segment.assetRef !== `recording:${sessionId}:${assetId}` || segment.mimeType !== mimeType) throw new TypeError('Recording segment identity mismatch.');
  const times = [segment.startMs, segment.endMs, segment.mediaStartMs, segment.mediaEndMs];
  if (times.some(value => !Number.isFinite(value) || value < 0) || segment.endMs < segment.startMs ||
    segment.mediaEndMs < segment.mediaStartMs || segment.mediaEndMs - segment.mediaStartMs < segment.endMs - segment.startMs) {
    throw new TypeError('Invalid recording segment intervals.');
  }
}
async function atomicJson(directory: string, name: string, value: unknown, exclusive = false): Promise<void> {
  const temporary = path.join(directory, `${name}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), {flag: 'wx'});
    if (exclusive) {
      try { await stat(path.join(directory, name)); throw Object.assign(new Error('Manifest exists'), {code: 'EEXIST'}); }
      catch (error: unknown) { if (!isMissing(error)) throw error; }
    }
    await rename(temporary, path.join(directory, name));
  } finally { await rm(temporary, {force: true}).catch(() => undefined); }
}
