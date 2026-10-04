import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {ScreenEvidence} from '@apprentice/contracts';
import type {VisionEvidenceStore, VisionFrame} from '../../../packages/screen/vision/queue.ts';

export type ScreenMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ProcessedFrame extends VisionFrame {
  readonly mediaType: ScreenMediaType; readonly bytes: Uint8Array;
}
export interface ScreenEvidenceRecord extends ScreenEvidence {
  readonly sessionId: string; readonly frameId: string;
  readonly mediaType: ScreenMediaType; readonly byteLength: number;
}
export interface EvidenceMetadataRepository {
  put(record: ScreenEvidenceRecord): Promise<void>; get(id: string): Promise<ScreenEvidenceRecord | undefined>;
  remove(id: string): Promise<void>;
}
export interface ScreenEvidenceStore extends VisionEvidenceStore<ProcessedFrame, ScreenEvidenceRecord> {
  read(id: string, options?: {signal?: AbortSignal}): Promise<{record: ScreenEvidenceRecord; bytes: Buffer}>;
}
const extensions: Readonly<Record<ScreenMediaType, string>> = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'};
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class EvidenceError extends Error { readonly code: EvidenceErrorCode; constructor(code: EvidenceErrorCode) { super(code); this.code = code; } }
export type EvidenceErrorCode = 'invalid_frame' | 'evidence_not_found' | 'storage_error';

export function normalizeFrame(frame: unknown, maxBytes = 8_000_000): ProcessedFrame {
  if (!isRecord(frame) || frame.processed !== true || !validId(frame.sessionId) || !validId(frame.frameId) ||
    !Number.isSafeInteger(frame.timestampMs) || (frame.timestampMs as number) < 0 ||
    !isMediaType(frame.mediaType) || !(frame.bytes instanceof Uint8Array) ||
    frame.bytes.length === 0 || frame.bytes.length > maxBytes) throw new EvidenceError('invalid_frame');
  const bytes = Buffer.from(frame.bytes);
  const validSignature = frame.mediaType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    frame.mediaType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!validSignature) throw new EvidenceError('invalid_frame');
  return {sessionId: frame.sessionId as string, frameId: frame.frameId as string,
    timestampMs: frame.timestampMs as number, processed: true, mediaType: frame.mediaType, bytes};
}
function recordFor(frame: ProcessedFrame, id: string): ScreenEvidenceRecord {
  return {schemaVersion: 1, id, kind: 'frame', sessionId: frame.sessionId, frameId: frame.frameId,
    assetRef: `/screen/sessions/${encodeURIComponent(frame.sessionId)}/evidence/${id}/asset`,
    startMs: frame.timestampMs, endMs: frame.timestampMs,
    mediaType: frame.mediaType, byteLength: frame.bytes.length};
}
function checkId(id: string): void { if (!idPattern.test(id)) throw new EvidenceError('evidence_not_found'); }

export function createFileEvidenceStore({mediaDir, metadata, maxBytes = 8_000_000}: {
  readonly mediaDir: string; readonly metadata: EvidenceMetadataRepository; readonly maxBytes?: number;
}): ScreenEvidenceStore {
  if (!mediaDir || !path.isAbsolute(mediaDir)) throw new TypeError('An absolute MEDIA_DIR is required');
  const filename = (record: ScreenEvidenceRecord): string => {
    checkId(record.id); return path.join(mediaDir, `${record.id}.${extensions[record.mediaType]}`);
  };
  const resolve = async (id: string, {signal}: {signal?: AbortSignal} = {}): Promise<ScreenEvidenceRecord> => {
    try {
      signal?.throwIfAborted(); checkId(id); const record = await metadata.get(id);
      if (!record || record.schemaVersion !== 1 || record.kind !== 'frame' || record.id !== id ||
        !validId(record.sessionId) || !validId(record.frameId) || !isMediaType(record.mediaType) ||
        record.assetRef !== `/screen/sessions/${encodeURIComponent(record.sessionId)}/evidence/${id}/asset` ||
        !Number.isSafeInteger(record.startMs) || !Number.isSafeInteger(record.endMs) ||
        record.startMs < 0 || record.endMs !== record.startMs ||
        !Number.isSafeInteger(record.byteLength) || record.byteLength < 1 || record.byteLength > maxBytes) {
        throw new EvidenceError('evidence_not_found');
      }
      signal?.throwIfAborted(); const info = await stat(filename(record)); signal?.throwIfAborted();
      if (!info.isFile() || info.size !== record.byteLength) throw new EvidenceError('evidence_not_found');
      return {...record};
    } catch (error: unknown) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError(isNodeError(error) && error.code === 'ENOENT' ? 'evidence_not_found' : 'storage_error');
    }
  };
  return {
    async save(input, {signal}) {
      signal.throwIfAborted(); const frame = normalizeFrame(input, maxBytes); const record = recordFor(frame, randomUUID());
      const target = filename(record); const temporary = `${target}.tmp`;
      try {
        await mkdir(mediaDir, {recursive: true, mode: 0o750});
        await writeFile(temporary, frame.bytes, {flag: 'wx', mode: 0o600, signal});
        signal.throwIfAborted(); await rename(temporary, target); signal.throwIfAborted();
        await metadata.put({...record}); signal.throwIfAborted(); return {...record};
      } catch (error: unknown) {
        await Promise.allSettled([unlink(temporary), unlink(target), metadata.remove(record.id)]);
        if (signal.aborted) throw signal.reason;
        throw new EvidenceError('storage_error');
      }
    },
    resolve,
    async read(id, options = {}) {
      const record = await resolve(id, options);
      try {
        const bytes = await readFile(filename(record), {signal: options.signal});
        if (bytes.length !== record.byteLength) throw new EvidenceError('evidence_not_found');
        return {record, bytes};
      } catch (error: unknown) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (error instanceof EvidenceError) throw error;
        throw new EvidenceError(isNodeError(error) && error.code === 'ENOENT' ? 'evidence_not_found' : 'storage_error');
      }
    },
  };
}

export function createMemoryEvidenceStore({maxEntries = 100, maxBytes = 8_000_000}: {
  readonly maxEntries?: number; readonly maxBytes?: number;
} = {}): ScreenEvidenceStore {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new TypeError('Invalid memory limit');
  const records = new Map<string, {record: ScreenEvidenceRecord; bytes: Buffer}>();
  const resolve = async (id: string, {signal}: {signal?: AbortSignal} = {}): Promise<ScreenEvidenceRecord> => {
    signal?.throwIfAborted(); checkId(id); const value = records.get(id);
    if (!value) throw new EvidenceError('evidence_not_found'); return {...value.record};
  };
  return {
    async save(input, {signal}) {
      signal.throwIfAborted(); const frame = normalizeFrame(input, maxBytes);
      if (records.size >= maxEntries) throw new EvidenceError('storage_error');
      const record = recordFor(frame, randomUUID()); records.set(record.id, {record, bytes: Buffer.from(frame.bytes)}); return {...record};
    },
    resolve,
    async read(id, options = {}) {
      const record = await resolve(id, options); const value = records.get(id);
      if (!value) throw new EvidenceError('evidence_not_found'); return {record, bytes: Buffer.from(value.bytes)};
    },
  };
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function isMediaType(value: unknown): value is ScreenMediaType { return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error; }
