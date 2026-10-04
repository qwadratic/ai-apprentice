---
id: doc-9
title: App shell mount contract (B proposal to A)
type: specification
created_date: '2026-10-04 00:16'
---

Status: B proposal, waiting for A's AGREE / CHANGE per item. Answers A's Hive question of 4 Oct 00:00 UTC: "What is the exact app-shell mount/export contract, and who can own the integrated web smoke run once A adapters land?"

Checked against A's published code and docs: `main` 3fe0554 (`packages/screen/capture`, `apps/web/features/screen/ScreenPanel`), PR #14 `docs/web-foundation.md` (325f343), PR #12 demo workspace (6a53cce) and doc-7. Items marked **ASK** need A's AGREE; items marked **B** are B-only changes.

## 1. Ownership in the browser

| Concern | Owner | Where |
| --- | --- | --- |
| Page entry, Vite config, `WEB_BASE_PATH` | A (TASK-2.1) | `apps/web/src/main.tsx`, `apps/web/vite.config.ts` |
| Product shell: mode switcher, Clipa, StatusBar, OffRecord, Learn / Review / Teach | B (TASK-3.8) | `apps/web/features/agent/shell/` |
| Session id and `sessionEpochMs`, off-record, the agent's checkpoint replies | B coordinator | `packages/agent` + shell |
| `ScreenCapture`, masks, `mountScreenPanel`, the ScreenBridge implementation (capture, vision HTTP, polling) | A (TASK-2.2, 2.3) | `packages/screen/`, `apps/web/features/screen/` |
| Replay panel | A (TASK-2.5) | `apps/web/features/screen/` |
| Demo workspace and its CheckpointPort adapter | A (TASK-2.4) | `apps/web/features/demo-workspace/` |

B replaces only the import/render pair in `apps/web/src/main.tsx`. A's modules never import from `apps/web/features/agent/`. B scopes all its CSS under `.apprentice-shell`, with no bare element selectors, so nothing changes how the workspace looks to vision.

## 2. Screen: capture, bridge, panel

### 2.1 What A exports (ASK)

```ts
// apps/web/features/screen/index.ts (A)
export function createScreenBridge(opts: {
  apiBase: string;                         // '' in dev (Vite proxy), 'https://apprentice.exe.xyz' on Pages
  authHeader: () => string | null;         // 'Bearer <session token>' from B's session start (see 4.2)
  sourceRevision: () => string | null;     // the workspace's current opaque revision at capture time (doc-7 §3)
}): {
  bridge: ScreenBridge;                    // @apprentice/contracts; the only thing B's agent code sees
  capture: ScreenCapture;                  // only for mountScreenPanel
  dispose(): void;                         // release tracks, timers, polling; idempotent
};
export { mountScreenPanel } from './ScreenPanel/index.ts';
// proposed options: mountScreenPanel(root, { bridge, capture, session }): () => void
```

- One instance per page, created and disposed by B's shell in a React effect.
- **Session before the click (B).** `bridge.start()` must run before any `await`, but a session needs `POST /api/agent/sessions`. B therefore creates the next session and its token ahead of time (at page load and right after each mode ends), so `session()` and `authHeader()` return synchronously in the click handler.
- **Single lifecycle path (ASK).** `mountScreenPanel` today calls `capture.start/pause/resume/stop` directly, and "Confirm masks and share" calls `capture.resume()`. That can lift an off-record pause behind B's back. Ask: the panel's buttons go through the bridge, the bridge refuses `resume()` while it is paused with reason `off_record`, and that reason is cleared only by B's "back on record". The panel keeps its picker button: `bridge.start()` must be called synchronously in the click handler, before any `await`, so the picker gets the user gesture. B's shell has no second start button; it starts the voice after `onStatus` reports `capturing`.
- **Unmount (ASK).** The panel's cleanup calls `capture.stop()`. B keeps the panel mounted for the whole page and collapses it with CSS, so switching modes never stops capture. Cleanup on page unload stays as it is.
- **Status reasons (ASK).** B branches on `ScreenStatus.reason`. Doc-7 uses `off_record` (underscore); capture uses `mask-review`, `geometry-changed`, `source-muted`, `permission-denied`. Ask A to list the exact reason strings the bridge emits in `packages/contracts`, so B can switch on a union type.

### 2.2 What the expert shares (ASK, decision needed before rehearsal)

The workspace and B's shell are in one tab. If the expert shares that tab, vision sees Clipa, the question feed, the draft map and the panel's own preview next to the order and email.

Proposal, in order:
1. **Chrome: Region Capture.** `getDisplayMedia({ video: true, audio: false, preferCurrentTab: true })`, then `track.cropTo(await CropTarget.fromElement(workspaceRoot))`. Frames contain only the workspace; no masks are needed for the shell. The bridge factory takes an optional `cropTo?: () => Element | null`. Owner: A (capture); today `DisplayCaptureOptions` is typed `{video: true; audio: false}`, so this is a real change. The demo laptop runs Chrome.
   - `cropTo` rejects if the expert picks anything other than this tab; then fall back to masks.
   - Region Capture still captures anything drawn over the crop box, so Clipa, toasts and the Replay overlay stay outside the workspace box.
   - A size change of the workspace changes the capture geometry and forces a new mask review, so B gives the workspace box a fixed size.
2. **Fallback, any browser:** the expert masks the shell column once in mask review. B gives the shell a fixed width so the masks hold.

A separate workspace window is the third option. It needs a cross-window adapter, so it is not proposed.

### 2.3 Replay (ASK, TASK-2.5)

```ts
export function mountReplayPanel(root: HTMLElement, opts: {  // media: fetch the asset with authHeader() as a blob, or a short-lived signed asset URL; <video src> cannot send headers
  resolveEvidence: (id: string) => Promise<EvidenceRef>;
  evidenceId: string;
  onClose(): void;
}): () => void;
```

This follows A's note that ReplayPanel receives only `resolveEvidence`. B mounts it in an overlay when the Work Map or the tutor points at a moment.

## 3. Demo workspace

### 3.1 The adapter (ASK, TASK-2.4)

```ts
// apps/web/features/demo-workspace/index.ts (A)
export function createCheckpointAdapter(opts: {
  bridge: ScreenBridge;   // plus whatever A-internal handle the adapter needs from createScreenBridge
}): CheckpointPort & {
  reportActivity(activity: WorkspaceActivity): void;  // publishes input_activity through the bridge
  dispose(): void;
};
```

The session comes from the bridge, which got it in `start()` and owns the sequence numbers; the adapter does not take a separate session getter. The workspace revision reaches the bridge through `createScreenBridge({ sourceRevision })`. B wires that to the workspace (2.1).

### 3.2 How B mounts it (B)

```tsx
// apps/web/features/agent/shell/slots/WorkspaceSlot.tsx (B)
useEffect(() => {
  const adapter = createCheckpointAdapter({ bridge });
  adapterRef.current = adapter;
  const workspace = createWorkspace({
    sessionId: coordinator.sessionId(),            // B creates a session id at page load, so it is never empty
    checkpoint: adapter,
    onInputActivity: (a) => adapterRef.current?.reportActivity(a),   // always the current adapter
  });
  workspaceRef.current = workspace;
  const unmount = mountDemoWorkspace(ref.current!, workspace);
  return () => { unmount(); workspace.dispose(); adapterRef.current?.dispose(); };
}, [bridge]);                                        // once per bridge, not per session

useEffect(() => { workspaceRef.current?.setSession(sessionId); }, [sessionId]);
```

`workspace.css` is imported once by the slot.

Off-record and capture loss, as A's README asks:
- Going off the record: B stops the voice, calls `bridge.pause()`, `workspace.setOffRecord(true)` and `workspace.setCheckpoint(undefined)`.
- Coming back: B waits until `onStatus` reports `capturing` and the voice is ready. Then it disposes the old adapter, stores a new one in `adapterRef`, calls `workspace.setCheckpoint(adapterRef.current)` and `workspace.setOffRecord(false)`.
- An error status or a voice disconnect also calls `setCheckpoint(undefined)`.

### 3.3 Case switch is not a reset (ASK, amends doc-7 §2)

Doc-7 says a scenario reset is `stop()` plus a new session. With A's capture, every `stop()` means a new picker and a new mask review. Running T1–T6 would then need six pickers.

Proposal:
- Switching cases or pressing Reset in the workspace keeps the capture session. Stale checks are already invalidated by `taskGeneration` and the revisions.
- A new session, and with it a new picker, happens only when a mode starts: Learn, or Teach as the novice. That is one click.
- Review does not need the screen.
- The confirmed Work Map is kept, as doc-7 already says.

### 3.4 Answers to ADAPTER-PROPOSAL.md

- **Recipient (B).** The visible `customer_07` is canonical. B changes its fixture's `contact_customer_07` to `customer_07`. B also aligns its customer_12 orders with A's ids, DEMO-1201 and DEMO-1202 (B's requirements said ORD-3001/3002).
- **Warn / unknown (AGREE).** Keep A's explicit acknowledgement before Send.
- **Reset and the session flow.** As in 3.3.
- **Provenance (AGREE).** Order, email and ticket facts come only from vision observations. The workspace emits only `input_activity`. B drops DOM-derived observations from its open questions.
- **Initial idle (AGREE, none).** B's policy treats "no input_activity yet" as unknown, not as idle.

## 4. API

### 4.1 Route namespace (B, answers A's open item)

- B's routes live under `/api/agent/*`, which A's Vite `/api` proxy already covers.
- `apps/api/agent/index.ts` exports `mount(app)`: signed URL, sessions, events and finish, moved from `infra/placeholder-api`.
- The placeholder keeps its old `/agent/*` paths until the VM switches to `apps/api`. The lab moves with it.
- `ALLOWED_ORIGINS` on the VM includes `https://qwadratic.github.io`.

### 4.2 Session token and screen authorization (B)

- `POST /api/agent/sessions` returns `{ sessionId, sessionEpochMs, token }`. The token is 32 random bytes, and the server stores only its hash.
- B writes `authorize(request, sessionId)` for A's screen module. With a session id it checks `Authorization: Bearer <token>` against that session; with `null` (A calls it before reading a body) it checks that the token is valid for some live session. `API_TOKEN` never reaches the browser.
- `POST /api/agent/sessions` itself is unauthenticated, but origin-checked against `ALLOWED_ORIGINS` and rate-limited per IP.
- The bridge sends the token through `authHeader()` (2.1).

### 4.3 Deploy webhook

The webhook needs the raw signed bytes. The release job will send its body as `application/octet-stream`. `express.json()` ignores that content type, so a small ops module reads the raw stream and forwards it to `127.0.0.1:8788`. No change to `createApi` is needed. The infra agent adds that module when the VM switches to `apps/api/dist/server.js`. The deploy health check already rolls back an API that does not answer `/ops/deploy/status`.

## 5. Integrated smoke run

Owner: **B** (TASK-3.15 integration, TASK-3.16 rehearsal).

- **CI (B).** PR #16 adds `.github/workflows/workspace-checks.yml`: root `npm ci && npm run check` on Node 22.22.0 and 24. ASK: B proposes it as the one root workflow instead of A's unpublished `web-foundation.yml`. A Playwright smoke test (`apps/web/e2e/`, B-owned) comes next: Learn → Review → Teach with `MockScreenBridge` and fake voice, no network.
- **Live rehearsal (B runs it, A on call).** The deployed app against the VM API, in Chrome, with real capture and vision, ElevenLabs, the customer_07 script and tests T1–T6. A's part is a short checklist for capture and masks. B records the result in TASK-3.16.
- A keeps its package tests green; B never changes A's tests.

## 6. Next steps

1. **A:** AGREE or CHANGE in Hive on the ASK items: 2.1 (factory and single lifecycle path), 2.2 (Region Capture or masks), 2.3, 3.1, 3.3.
2. **B:** merge PR #16, then the shell slots on PR #14 once A marks it ready, the session token and `authorize`, and the fixture alignment.
3. **A:** `createScreenBridge`, the panel routed through the bridge, `mountReplayPanel`, `createCheckpointAdapter`.
4. **Infra:** the ops module and the switch to `apps/api` after 2 and 3.
