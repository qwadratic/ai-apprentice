import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class EvidenceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Processed is an explicit trust boundary, not an automatic PII detector. */
export function normalizeFrame(frame, maxBytes = 8_000_000) {
  if (!frame || frame.processed !== true ||
    ![frame.sessionId, frame.frameId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) ||
    !Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0 ||
    !Object.hasOwn(extensions, frame.mediaType) || !(frame.bytes instanceof Uint8Array) ||
    frame.bytes.length === 0 || frame.bytes.length > maxBytes) throw new EvidenceError('invalid_frame');
  const bytes = Buffer.from(frame.bytes);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp })[frame.mediaType]) {
    throw new EvidenceError('invalid_frame');
  }
  return { sessionId: frame.sessionId, frameId: frame.frameId, timestampMs: frame.timestampMs,
    processed: true, mediaType: frame.mediaType, bytes };
}

function recordFor(frame, id) {
  return { id, kind: 'frame', sessionId: frame.sessionId, frameId: frame.frameId,
    assetRef: `/screen/evidence/${id}/asset`, startMs: frame.timestampMs, endMs: frame.timestampMs,
    mediaType: frame.mediaType, byteLength: frame.bytes.length };
}

function checkId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new EvidenceError('evidence_not_found');
}

/** Metadata repository is injected from the shared backend; no competing DB/schema. */
export function createFileEvidenceStore({ mediaDir, metadata, maxBytes = 8_000_000 }) {
  if (!mediaDir || !path.isAbsolute(mediaDir) || !metadata?.put || !metadata?.get || !metadata?.remove) {
    throw new TypeError('An absolute MEDIA_DIR and metadata repository are required');
  }
  const filename = record => {
    checkId(record.id);
    if (!Object.hasOwn(extensions, record.mediaType)) throw new EvidenceError('evidence_not_found');
    return path.join(mediaDir, `${record.id}.${extensions[record.mediaType]}`);
  };
  async function getRecord(id, signal) {
    signal?.throwIfAborted();
    checkId(id);
    const record = await metadata.get(id);
    if (!record || record.id !== id || record.assetRef !== `/screen/evidence/${id}/asset` ||
      !Number.isSafeInteger(record.byteLength) || record.byteLength < 1 || record.byteLength > maxBytes) {
      throw new EvidenceError('evidence_not_found');
    }
    signal?.throwIfAborted();
    return record;
  }
  return {
    async save(input, { signal } = {}) {
      signal?.throwIfAborted();
      const frame = normalizeFrame(input, maxBytes);
      const record = recordFor(frame, randomUUID());
      const target = filename(record);
      const temporary = `${target}.tmp`;
      try {
        await mkdir(mediaDir, { recursive: true, mode: 0o750 });
        await writeFile(temporary, frame.bytes, { flag: 'wx', mode: 0o600, signal });
        signal?.throwIfAborted();
        await rename(temporary, target);
        signal?.throwIfAborted();
        await metadata.put({ ...record });
        signal?.throwIfAborted();
        return { ...record };
      } catch (error) {
        // Cleanup is best effort. The backend owns retries/retention for orphaned media.
        await Promise.allSettled([unlink(temporary), unlink(target), metadata.remove(record.id)]);
        if (signal?.aborted) throw signal.reason;
        throw new EvidenceError('storage_error');
      }
    },
    async resolve(id, { signal } = {}) {
      try {
        const record = await getRecord(id, signal);
        const info = await stat(filename(record));
        signal?.throwIfAborted();
        if (!info.isFile() || info.size !== record.byteLength) throw new EvidenceError('evidence_not_found');
        return { ...record };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof EvidenceError) throw error;
        throw new EvidenceError(error?.code === 'ENOENT' ? 'evidence_not_found' : 'storage_error');
      }
    },
    async read(id, { signal } = {}) {
      const record = await this.resolve(id, { signal });
      try {
        const bytes = await readFile(filename(record), { signal });
        if (bytes.length !== record.byteLength) throw new EvidenceError('evidence_not_found');
        return { record, bytes };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof EvidenceError) throw error;
        throw new EvidenceError(error?.code === 'ENOENT' ? 'evidence_not_found' : 'storage_error');
      }
    },
  };
}

/** Bounded synthetic-test adapter, deliberately nonpersistent. */
export function createMemoryEvidenceStore({ maxEntries = 100, maxBytes = 8_000_000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new TypeError('Invalid memory limit');
  const records = new Map();
  return {
    async save(input, { signal } = {}) {
      signal?.throwIfAborted();
      const frame = normalizeFrame(input, maxBytes);
      if (records.size >= maxEntries) throw new EvidenceError('storage_error');
      const record = recordFor(frame, randomUUID());
      records.set(record.id, { record, bytes: frame.bytes });
      return { ...record };
    },
    async resolve(id, { signal } = {}) {
      signal?.throwIfAborted();
      checkId(id);
      const value = records.get(id);
      if (!value) throw new EvidenceError('evidence_not_found');
      return { ...value.record };
    },
    async read(id, options) {
      const record = await this.resolve(id, options);
      return { record, bytes: Buffer.from(records.get(id).bytes) };
    },
  };
}
