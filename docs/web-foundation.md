# TASK-2.1 foundation and integration handoff

## Status and remaining decisions

The foundation is implemented against base `16ab4635eb63eb75e28247e704e966a9b16e7544`.
It is a development scaffold. The default web view clearly labels its synthetic mock;
no screen, voice, tutor, database, or model runner is connected.

The field schema and lifecycle semantics implement the agreement accepted by both
owners in doc-7 at main `0109c64dcd4d8499fff4c401313a59a3175e7a16`.
`CONTRACT_REVIEW_STATUS` is `accepted-doc-7`. The final lifecycle decision keeps
start/resume as `Promise<void>` commands with results reported through `onStatus`.
TASK-1 remains open until canonical imports,
real integration, and its acceptance criteria are verified.

B's earlier draft at `693f11a52b81891d1165c92b580bf466a73ed657` is historical.
Doc-7 supersedes its non-null order fields, ticket note, old heartbeat, missing
provenance, and checkpoint shapes. B migrates its private copy in TASK-3.23.
Neutral runtime fixtures contain no customer rule, question, or tutor result.
This worktree stays on its original base; publication belongs to the coordinator.
Cherry-pick only the new local code commit onto current main and reconcile the
separate TASK-2.1 notes through Backlog.

Open decisions (the independent scaffold does not depend on approval):

1. npm, React 19/Vite 7, Express 5 and the mount wrapper need integration review.
   Node minimum stays 22.22 per TASK-3.1. Add B's requested SDK dependencies only when
   its consuming package needs them; do not create a second runner.
2. Real source provenance is still an integration dependency: a registry must bind
   each order/email observation to session/generation and source revisions, and
   revalidate both on reply and Send. HTTP vision frames are history-only until
   that trusted adapter exists. ObservationGate alone does not establish provenance.
3. The accepted polling endpoint is owned by vision/API and remains unimplemented
   here; the skeleton must not claim completed server-to-browser delivery.

## Reproduce locally

Use Node >=22.22 and npm >=10.9 (`.nvmrc` pins 22.22; lockfile uses npm 10.9.4).
The system Node 16/npm 8 is not supported. With nvm: `nvm install && nvm use`.
There is one root `package-lock.json`. `infra/` is deliberately excluded from
workspaces and keeps TASK-4's independently specified runner installation.

```sh
npm ci
npm run typecheck
npm test
npm run build
# Equivalent checks:
npm run check
# Start both processes; Ctrl-C shuts both down:
npm run dev
# Or in separate terminals:
npm run dev:api
npm run dev:web
# Run built API (required TASK-4 entry):
npm start --workspace @apprentice/api
```

Web: http://127.0.0.1:5173. API: http://127.0.0.1:8000/health.
Root dev/typecheck/test commands build contracts first. For direct workspace
commands after a fresh install, first run
`npm run build --workspace @apprentice/contracts`. After changing contracts during
dev, rebuild that workspace. Package checks use native Node TypeScript stripping,
explicit `.ts` imports and erasable syntax; emitted imports are rewritten to `.js`.

The web dev server proxies `/health`, `/api` and the existing `/screen` namespace without rewriting routes. Override
`API_PROXY_TARGET` for another development API. Backend CORS uses exact comma-separated
`ALLOWED_ORIGINS` and refuses other browser Origins; the default empty list accepts
only requests without Origin. Same-origin Vite requests work through the proxy.
For direct browser API access set the actual frontend origin. `.env.example` is
reference only: the API reads process.env and does not implicitly load .env files.
`DATABASE_PATH`, `MEDIA_DIR`, `RUNNER_URL`, `RUNNER_TOKEN` are passed privately by
TASK-4 and consumed by the owning modules. This bootstrap does not create another
runner, database or model endpoint. No secret belongs in any `VITE_*` value.

Built web output is `apps/web/dist/`, API entry is `apps/api/dist/server.js`.
Set `WEB_BASE_PATH=/ai-apprentice/` at build for GitHub Pages or leave `/` for root hosting.
B owns production API URL wiring in its shell; the proxy applies only in development.
`/health` reports only actual mounted modules, not model/voice/storage readiness.

## Shared imports and owner boundaries

```ts
import { SCHEMA_VERSION, ObservationGate, parseScreenObservation,
  assertCurrentCheckpoint, parseCheckpointReply } from '@apprentice/contracts';
import type { ScreenBridge, ScreenObservation, ScreenStatus, ScreenEvidence,
  ActionCheckpoint, CheckpointReply, CheckpointHandler } from '@apprentice/contracts';
import { MockScreenBridge } from '@apprentice/contracts/mock';
import { createScreenFixtures } from '@apprentice/contracts/fixtures';
```

Consumers add `"@apprentice/contracts": "0.0.0"` to their package dependencies.
The workspace symlink and compiled exports resolve in browsers and Node production.
A manages root dependency updates/lockfile; do not generate nested application
lockfiles. B's standalone package can keep native node:test; replace its private
contract imports only after shared approval. Root tests/typechecks discover new
workspace scripts with `--workspaces --if-present`. Build ordering for newly added
packages should be added by the skeleton owner when those manifests are available.

| Owner | Files and hookup |
| --- | --- |
| TASK-2.1 | Root npm/TS config, scripts, packages/contracts, docs, minimal web/API bootstrap |
| Capture/privacy TASK-2.2 | packages/screen capture/privacy; apps/web/features/screen/ScreenPanel; consume SessionStart and ObservationGate |
| Vision/Evidence TASK-2.3 | packages/screen vision/evidence; apps/api/screen; parse observations and use frame capture tokens, not response timestamps |
| Replay TASK-2.5 | apps/web/features/screen/ReplayPanel; resolve Evidence through the shared bridge |
| Sandbox TASK-2.4 | apps/web/features/demo-workspace; CheckpointPort adapter backed by approved bridge; typed facts + local heartbeat |
| B | packages/agent, apps/web/features/agent and app shell, apps/api/agent, fixtures/agent |
| TASK-4 | infra only; deploy root npm ci and API build, run apps/api/dist/server.js |

No implementation files or mock placeholders are created in another worker's
feature/module directories. Their absence does not break install/check/build.

### Capture and vision

B creates `sessionId`/`sessionEpochMs` and starts the bridge. Capture assigns its
frame ID and `timestampMs = capturedAtEpochMs - sessionEpochMs` before async vision.
`ObservationGate.capture(capturedAtEpochMs, frameId, sourceRevision)` creates a
token carrying session, generation, sequence, and the trusted capture-time revision.
On completion, construct a full vision observation
with exactly that token's timing/sequence; `gate.publish(token, observation)`
returns validated output or null for invalidated/out-of-order work. It does not
implement masking, capture, persistence or cancellation. The owner must gate all
external sends and recording commits, not only observation callbacks.

### B app shell and feature panels

The only web entry to replace is `apps/web/src/main.tsx`: import/render B's app
instead of `Foundation`. The isolated `apps/web/foundation/` debug view can remain
as a development aid. It is not Learn/Review/Teach.

The published capture panel is a DOM adapter, not a React component:
`mountScreenPanel(root, {capture, session})` from
`apps/web/features/screen/ScreenPanel/index.ts`. Mount it in a React ref/effect
and return its cleanup. Capture imports intentionally use `.js` extensions for
TypeScript build output; do not rewrite them. Demo uses `.ts` imports:
`createWorkspace` and `mountDemoWorkspace` from
`apps/web/features/demo-workspace/index.ts`, plus `workspace.css`. Its local
CheckpointPort must acquire fresh order/email observation IDs and correlate B's
reply; it is not a direct domain-state feed to the tutor. Dispose the workspace
on cleanup and disconnect its adapter on off-record. These owner modules are not
copied into this base worktree.

B creates the session/coordinator and the shared real bridge. ReplayPanel receives that bridge's `resolveEvidence` and the selected
evidence ID/time from B's map. Demo workspace receives the approved bridge-backed CheckpointPort adapter and
publishes only input_activity directly; order/email/ticket facts must come from
processed pixels through vision. Its DOM mount uses
React ref/effect cleanup; ReplayPanel's actual export still needs the TASK-2.5
owner's agreement. This scaffold does not invent feature implementations.
B owns composition, voice/off-record, questions, Work Map and tutor decisions.

### API modules

Owner wrapper modules expose `mount(app: Express): void | Promise<void>`.
The published screen library exports `mount(app, {register, service, authorize})`
from `apps/api/screen/index.mjs`, with Fetch Request/Response handlers on
`/screen/frames`, `/screen/evidence/:id` and `/screen/evidence/:id/asset`.
Use our `registerWebRoute` from `src/web-routes.ts` as its framework adapter:
`{name: 'screen', mount: app => mountScreen(app, {register: registerWebRoute,
service, authorize})}`. The service and authorization are provided by their owners;
no screen handler is duplicated or mounted without these dependencies.
The API build copies imported `.mjs` modules, with checkJs disabled. The agent
wrapper and its route namespace still need B's agreement. Existing ElevenLabs
scripts/configuration are preserved; B must supply its mount and any static assets
needed by it. `apps/api/src/modules.ts`
is the one shared registry seam for wrappers with the one-argument signature:

```ts
// After owner wrappers exist (the registry is empty until then):
import { mount as mountScreen } from '../screen/bootstrap.ts';
import { mount as mountAgent } from '../agent/index.ts';
export const modules = [
  { name: 'screen', mount: mountScreen },
  { name: 'agent', mount: mountAgent },
];
```

`createApi` awaits mounts before listening. It installs common CORS, JSON body
limit, health, and the final 404/error handlers once. Modules own authorization,
vision/knowledge routes, runner calls and persistence. Agree another mount type
with the orchestrator if TASK-4/B has an unpublished framework decision.
There are no auto-scanned plugins, duplicate handlers or fallbacks pretending a
missing module is live. The minimal shared API files are `server.ts`, `src/app.ts`,
`src/modules.ts`, `src/server.ts` and their TS configs.

## Verified results

- Node 22.22.0 / npm 10.9.4: clean `npm ci --no-audit --no-fund` passed;
  pre-doc-7 `npm run check` passed. The doc-7 follow-up is verified separately in
  its local commit and updates this count to 20 contract + 3 API tests.
- Node 24.19.0 / npm 10.9.4: doc-7 `npm run check` passed with all 23 tests.
- `npm run dev`: both servers started. Final B-aligned UI verified start, pause
  skipping due events, resume at sequence 4 / timestampMs 4000, unknown customer
  null, and stop without more events. Both servers shut down cleanly.
- Built `apps/api/dist/server.js`: health 200, allowed CORS preflight 204, absent
  screen route 404. Compiled B-compatible package imports passed on Node 22.22.
- Fetch-handler mount test verified JSON, authorization header, path params and
  streamed response status/headers. Doc-7 schema and lifecycle tests passed.
- `git diff --cached --check` passed; credential-pattern scan found no matches.
  All fixture data is synthetic. Remote CI is unrun because this branch is local.
- No existing B root/app implementation path at main 0109c64 is replaced. The only
  existing changed files are root README/.gitignore and, in a separate commit,
  TASK-2.1. All feature-owner implementations remain untouched.

## Exact implementation file inventory

- `.env.example`
- `.github/workflows/web-foundation.yml`
- `.gitignore`
- `.npmrc`
- `.nvmrc`
- `README.md`
- `apps/api/package.json`
- `apps/api/server.ts`
- `apps/api/src/app.ts`
- `apps/api/src/modules.ts`
- `apps/api/src/server.ts`
- `apps/api/src/web-routes.ts`
- `apps/api/test/app.test.ts`
- `apps/api/tsconfig.build.json`
- `apps/api/tsconfig.json`
- `apps/web/foundation/Foundation.tsx`
- `apps/web/index.html`
- `apps/web/package.json`
- `apps/web/src/main.tsx`
- `apps/web/tsconfig.json`
- `apps/web/vite.config.ts`
- `docs/web-foundation.md`
- `package-lock.json`
- `package.json`
- `packages/contracts/README.md`
- `packages/contracts/package.json`
- `packages/contracts/src/fixtures.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/lifecycle.ts`
- `packages/contracts/src/mock.ts`
- `packages/contracts/src/types.ts`
- `packages/contracts/src/validators.ts`
- `packages/contracts/test/contracts.test.ts`
- `packages/contracts/test/doc7-contract.test.ts`
- `packages/contracts/tsconfig.build.json`
- `packages/contracts/tsconfig.json`
- `scripts/dev.mjs`
- `tsconfig.base.json`

Transfer the separate Backlog notes through the CLI against current main to
preserve the coordinator's newer TASK-2.1 entries. This task remains In Progress.


## Current-main publication checks

The publication branch includes the existing Stream B agent workspace in the root
lockfile. The independently built `features/agent/lab` keeps its own tsconfig and
CI checks; it is excluded from the new web shell's compiler context.
The API runs its TypeScript entry directly on Node 22.22+, as agreed in doc-8; its
build command type-checks without emitting copies of imported screen sources.
The root TypeScript 7 consolidation and complete strict flags are a separate
in-progress follow-up. This slice exposes the canonical contract and scaffold,
but does not connect the real screen/agent modules or replace the deployed lab.
