import type {ActionCheckpoint, ScreenObservation} from '@apprentice/contracts';
import type {ScreenEvidenceRecord} from './evidence-store.ts';
import type {VisionPublicationContext, VisionSurface} from '../../../packages/screen/vision/queue.ts';

export interface ObservationBinding {
  readonly observationId: string; readonly sessionId: string; readonly serverGeneration: number;
  readonly queueGeneration: number; readonly captureGeneration: number | null; readonly frameId: string;
  readonly surface: VisionSurface; readonly sourceRevision: string; readonly evidenceId: string;
}
export class ProvenanceError extends Error {
  readonly code: 'checkpoint_untracked' | 'checkpoint_stale';
  constructor(code: 'checkpoint_untracked' | 'checkpoint_stale') { super(code); this.code = code; }
}
export class ObservationProvenanceRegistry {
  readonly #records = new Map<string, ObservationBinding>();
  readonly #latest = new Map<'order_view' | 'email_draft', ObservationBinding>();
  readonly sessionId: string; readonly serverGeneration: number; readonly maxRecords: number;
  constructor(sessionId: string, serverGeneration: number, maxRecords = 128) {
    if (!sessionId || !Number.isSafeInteger(serverGeneration) || serverGeneration < 1 ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 2) throw new TypeError('Invalid provenance registry');
    this.sessionId = sessionId; this.serverGeneration = serverGeneration; this.maxRecords = maxRecords;
  }
  record(observation: ScreenObservation, context: VisionPublicationContext<ScreenEvidenceRecord>): void {
    if (observation.sessionId !== this.sessionId || observation.source !== 'vision' || !observation.frameId ||
      !context.sourceRevision || !context.surface || observation.sourceRevision !== context.sourceRevision ||
      surfaceFor(observation.kind) !== context.surface || !observation.evidenceIds.includes(context.evidence.id)) return;
    const binding: ObservationBinding = Object.freeze({observationId: observation.id, sessionId: observation.sessionId,
      serverGeneration: this.serverGeneration, queueGeneration: context.queueGeneration,
      captureGeneration: context.captureGeneration, frameId: observation.frameId, surface: context.surface,
      sourceRevision: context.sourceRevision, evidenceId: context.evidence.id});
    this.#records.set(observation.id, binding);
    if (observation.kind === 'order_view' || observation.kind === 'email_draft') this.#latest.set(observation.kind, binding);
    while (this.#records.size > this.maxRecords) {
      const oldest = this.#records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#records.delete(oldest);
      for (const [kind, latest] of this.#latest) if (latest.observationId === oldest) this.#latest.delete(kind);
    }
  }
  assertCheckpoint(checkpoint: ActionCheckpoint, currentCaptureGeneration: number): {
    readonly order: ObservationBinding; readonly email: ObservationBinding;
  } {
    if (checkpoint.sessionId !== this.sessionId) throw new ProvenanceError('checkpoint_stale');
    const order = this.#latest.get('order_view'); const email = this.#latest.get('email_draft');
    if (!order || !email || !checkpoint.observationIds.includes(order.observationId) ||
      !checkpoint.observationIds.includes(email.observationId)) throw new ProvenanceError('checkpoint_untracked');
    for (const binding of [order, email]) {
      if (binding.serverGeneration !== this.serverGeneration || binding.captureGeneration !== currentCaptureGeneration ||
        !this.#records.has(binding.observationId)) throw new ProvenanceError('checkpoint_stale');
    }
    if (order.sourceRevision !== checkpoint.revisions.order || email.sourceRevision !== checkpoint.revisions.email) {
      throw new ProvenanceError('checkpoint_stale');
    }
    return {order, email};
  }
  get(observationId: string): ObservationBinding | undefined { return this.#records.get(observationId); }
}
function surfaceFor(kind: ScreenObservation['kind']): VisionSurface | null {
  return kind === 'order_view' ? 'order' : kind === 'email_draft' ? 'email' : kind === 'ticket' ? 'ticket' : null;
}
