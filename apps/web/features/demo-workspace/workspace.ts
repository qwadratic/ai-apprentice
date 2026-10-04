import { demoCases, type DemoCase, type Attachment } from './cases.ts';
import { createInputActivityReporter, type ActivityClock, type WorkspaceActivity, type WorkspaceSurface } from './activity.ts';

export type OpaqueRevisions = { order: string; email: string };
export type VersionScope = { sessionId: string; taskGeneration: number; draftRevision: number; revisions: OpaqueRevisions };
export type CheckOutcome = { status: 'clear' | 'warn' | 'unknown'; message: string; evidenceIds: string[] };
// This local dependency-injection port is not a second ScreenBridge contract.
export type CheckpointPort = {
  check(scope: VersionScope, signal: AbortSignal, onDispatch?: () => void): Promise<CheckOutcome>;
};
export type CheckState =
  | { status: 'idle' }
  | { status: 'acquiring'; requestId: number }
  | { status: 'pending'; requestId: number }
  | ({ status: 'clear' | 'warn' | 'unknown'; requestId: number } & Omit<CheckOutcome, 'status'>)
  | { status: 'error'; message: string };
export type WorkspaceState = {
  scope: VersionScope; caseId: string; order: DemoCase['order']; draft: DemoCase['draft']; offRecord: boolean;
  check: CheckState; acknowledged: boolean;
  sent: null | { subject: string; body: string; customerRef: string | null; attachments: Attachment[]; sentAtMs: number };
  ticket: { summary: string; status: 'open' | 'resolved' };
};
type Options = {
  sessionId: string; checkpoint?: CheckpointPort; cases?: readonly DemoCase[];
  acquisitionTimeoutMs?: number; replyTimeoutMs?: number; timeoutMs?: number;
  now?: () => number; onInputActivity?: (activity: WorkspaceActivity) => void; activityClock?: ActivityClock;
  createRevision?: () => string;
};

function sameScope(a: VersionScope, b: VersionScope): boolean {
  return a.sessionId === b.sessionId && a.taskGeneration === b.taskGeneration && a.draftRevision === b.draftRevision;
}
function validOutcome(value: CheckOutcome): boolean {
  return !!value && ['clear', 'warn', 'unknown'].includes(value.status) && typeof value.message === 'string' &&
    Array.isArray(value.evidenceIds) && value.evidenceIds.every(id => typeof id === 'string');
}

export function createWorkspace(options: Options) {
  const cases = options.cases ?? demoCases;
  if (!options.sessionId.trim() || !cases.length) throw new Error('A session and at least one case are required.');
  const now = options.now ?? Date.now;
  let revisionSequence = 0;
  const createRevision = options.createRevision ?? (() => `workspace-revision-${++revisionSequence}`);
  const activity = createInputActivityReporter(options.onInputActivity, options.activityClock);
  let checkpoint = options.checkpoint;
  let disposed = false;
  let requestSequence = 0;
  let active: { id: number; scope: VersionScope; abort: AbortController; timer: ReturnType<typeof setTimeout>; done: () => void } | undefined;
  const listeners = new Set<(state: WorkspaceState) => void>();
  const first = cases[0]!;
  let state: WorkspaceState = {
    scope: { sessionId: options.sessionId, taskGeneration: 0, draftRevision: 0,
      revisions: { order: createRevision(), email: createRevision() } }, caseId: first.id,
    order: structuredClone(first.order), draft: structuredClone(first.draft), offRecord: false, check: { status: 'idle' }, acknowledged: false,
    sent: null, ticket: { summary: '', status: 'open' },
  };
  const snapshot = () => structuredClone(state);
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const alive = () => { if (disposed) throw new Error('Workspace has been disposed.'); };
  function cancel() {
    if (!active) return;
    const previous = active;
    active = undefined;
    clearTimeout(previous.timer);
    previous.abort.abort();
    previous.done();
  }
  function invalidate(revision: 'order' | 'email' | 'both' | 'none' = 'email') {
    cancel();
    state.scope.draftRevision++;
    if (revision === 'order' || revision === 'both') state.scope.revisions.order = createRevision();
    if (revision === 'email' || revision === 'both') state.scope.revisions.email = createRevision();
    state.check = { status: 'idle' };
    state.acknowledged = false;
  }
  function editDraft(patch: Partial<DemoCase['draft']>) {
    alive();
    if (state.sent) return false;
    state.draft = { ...state.draft, ...structuredClone(patch) };
    invalidate('email');
    emit();
    return true;
  }
  function canSend() {
    return !disposed && !state.offRecord && !state.sent && (state.check.status === 'clear' ||
      ((state.check.status === 'warn' || state.check.status === 'unknown') && state.acknowledged));
  }
  function reset(caseId = state.caseId) {
    alive();
    const selected = cases.find(item => item.id === caseId);
    if (!selected) throw new Error('Unknown demo case.');
    activity.reset();
    invalidate('both');
    state = { ...state, scope: { ...state.scope, taskGeneration: state.scope.taskGeneration + 1 },
      caseId, order: structuredClone(selected.order), draft: structuredClone(selected.draft),
      sent: null, ticket: { summary: '', status: 'open' } };
    emit();
  }
  async function preview(): Promise<void> {
    alive();
    if (active || state.sent) return;
    if (state.offRecord) {
      state.check = { status: 'error', message: 'Workspace is off record. Resume before Preview.' };
      emit(); return;
    }
    if (!checkpoint) {
      state.check = { status: 'error', message: 'No agent is connected. The draft has not been checked.' };
      state.acknowledged = false;
      emit();
      return;
    }
    const port = checkpoint;
    const id = ++requestSequence;
    invalidate('email');
    const scope = structuredClone(state.scope);
    const abort = new AbortController();
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    const current = () => !disposed && active?.id === id && sameScope(scope, state.scope);
    function finish(check: CheckState) {
      if (!current()) return;
      state.check = check;
      state.acknowledged = false;
      cancel();
      emit();
    }
    const acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? 15_000;
    const replyTimeoutMs = options.replyTimeoutMs ?? options.timeoutMs ?? 4_000;
    const timer = setTimeout(() => finish({ status: 'error', message: 'Timed out acquiring current screen evidence. Preview again.' }), acquisitionTimeoutMs);
    active = { id, scope, abort, timer, done: complete };
    state.check = { status: 'acquiring', requestId: id };
    state.acknowledged = false;
    emit();
    // Detached work is bounded by completion/timeout; an adapter may ignore abort.
    void (async () => {
      try {
        const reply = await port.check(structuredClone(scope), abort.signal, () => {
          if (!current() || state.check.status !== 'acquiring') return;
          clearTimeout(active!.timer);
          active!.timer = setTimeout(() => finish({ status: 'error', message: 'Agent reply timed out. Preview again before sending.' }), replyTimeoutMs);
          state.check = { status: 'pending', requestId: id };
          emit();
        });
        if (!current()) return;
        if (!validOutcome(reply)) throw new Error('The agent returned an invalid check result.');
        finish({ ...structuredClone(reply), requestId: id });
      } catch (error) {
        finish({ status: 'error', message: error instanceof Error ? error.message : 'Check failed. Preview again before sending.' });
      }
    })();
    await completion;
  }
  return {
    getState: snapshot, getCases: () => structuredClone(cases), canSend, preview, editDraft, reset,
    subscribe(listener: (state: WorkspaceState) => void) {
      alive(); listeners.add(listener); listener(snapshot()); return () => { listeners.delete(listener); };
    },
    editOrder(patch: Partial<DemoCase['order']>) {
      alive(); if (state.sent) return false;
      state.order = { ...state.order, ...structuredClone(patch) }; invalidate('order'); emit(); return true;
    },
    setSession(sessionId: string) {
      alive(); if (!sessionId.trim()) throw new Error('A session is required.');
      if (sessionId === state.scope.sessionId) return;
      activity.reset(); invalidate('both'); state.scope.sessionId = sessionId; emit();
    },
    setCheckpoint(port?: CheckpointPort) { alive(); invalidate('none'); checkpoint = port; emit(); },
    setOffRecord(offRecord: boolean) {
      alive(); if (state.offRecord === offRecord) return;
      state.offRecord = offRecord;
      if (offRecord) activity.pause(); else activity.resume();
      invalidate('none'); emit();
    },
    acknowledgeRisk(acknowledged: boolean) {
      alive();
      state.acknowledged = (state.check.status === 'warn' || state.check.status === 'unknown') && acknowledged;
      emit();
    },
    send() {
      alive(); if (!canSend()) return false;
      state.sent = { ...structuredClone(state.draft), sentAtMs: now() };
      state.scope.revisions.email = createRevision();
      state.ticket = { summary: `Simulated email sent for ${state.order.id}.`, status: 'open' };
      emit(); return true;
    },
    editTicket(summary: string) { alive(); state.ticket.summary = summary; emit(); },
    resolveTicket() { alive(); if (!state.sent) return false; state.ticket.status = 'resolved'; emit(); return true; },
    inputActivity(surface: WorkspaceSurface = 'email') { alive(); activity.input(surface); },
    dispose() { if (disposed) return; disposed = true; activity.dispose(); cancel(); listeners.clear(); },
  };
}
export type WorkspaceController = ReturnType<typeof createWorkspace>;
