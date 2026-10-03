# infra/ — VM backend on exe.dev (TASK-4)

Owner: TASK-4 (@qwadratic, delegated to the agent on the exe.dev VM). Nothing here is imported by `apps/` or `packages/`; streams A and B talk to it over HTTP only.

```
infra/
  claude-runner/      Claude runner (TypeScript, Agent SDK), 127.0.0.1:8787, own package-lock.json
  placeholder-api/    dependency-free public API placeholder, 0.0.0.0:8000
  start-api.sh        starts apps/api/dist/server.js if it exists, else the placeholder
  systemd/            apprentice-runner/-api/-deploy units, deploy timer, sudoers rule
  deploy/deploy.sh    pull, install by lockfile, build, restart, health check, roll back
  install.sh          idempotent installer (sudo)
  check.sh            doc-5 acceptance checks (local or through the public URL)
```

`infra/` uses **npm**, not the root package manager, and must never match a root workspace glob (keep `pnpm-workspace.yaml` / `workspaces` to `apps/*` and `packages/*`).

## Host

| | |
|---|---|
| Public URL | `https://apprentice.exe.xyz` → VM port **8000** (only public port) |
| Runner | `http://127.0.0.1:8787` (loopback only; bearer `RUNNER_TOKEN`) |
| Code | `/opt/apprentice/infra` (copy installed by `install.sh`), `/opt/apprentice/repo` (anonymous clone of `main`, touched only by `deploy.sh`) |
| Data | `/var/lib/apprentice/{db,media,runner-cwd}`, owner `apprentice`, mode 750; survives restarts and reboots |
| Secrets | `/etc/apprentice/env`, root:root 0600, loaded by systemd `EnvironmentFile=` |
| OS | Ubuntu 24.04, systemd 255, Node 24 LTS, pnpm via corepack |

## Manual steps for Ivan

1. Make the proxy public (from your machine; `ssh exe.dev` does not work from inside the VM):
   ```
   ssh exe.dev share set-public apprentice
   ssh exe.dev share port apprentice 8000     # only if the public port is not already 8000
   ```
   Without `set-public` every public request is redirected to the exe.dev login.
2. Fill the secrets on the VM: `sudoedit /etc/apprentice/env` — `ELEVENLABS_API_KEY`, exactly **one** of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, and `ALLOWED_ORIGINS`. Then `sudo systemctl restart apprentice-runner apprentice-api`.
3. **Before any judge-facing URL is shared:** switch to API-key auth (Agent SDK terms): set `ANTHROPIC_API_KEY`, delete the `CLAUDE_CODE_OAUTH_TOKEN` value, restart, and confirm `mode` is `apikey`:
   `curl -s localhost:8787/health | jq .mode`.
4. Optional: enable automatic deploys (every minute, only acts when `origin/$DEPLOY_REF` moved):
   `sudo systemctl enable --now apprentice-deploy.timer` (disable with `sudo systemctl disable --now apprentice-deploy.timer`).

## Operations

```bash
# install or update infra from a clone (idempotent)
sudo ~/work/ai-apprentice/infra/install.sh
# deploy main now (no-op if unchanged; --force redeploys the same sha)
sudo -u apprentice /opt/apprentice/infra/deploy/deploy.sh [--force]
# or through systemd (same script, logs in journald)
sudo systemctl start apprentice-deploy.service
# logs (metadata only: request id, route, status, duration, sizes, model)
sudo journalctl -u apprentice-api -u apprentice-runner -f
sudo journalctl -u apprentice-deploy -n 50
systemctl list-timers apprentice-deploy.timer
# acceptance checks (on the VM; see the header of check.sh for the public variant)
~/work/ai-apprentice/infra/check.sh
```

`deploy.sh` (run as `apprentice` under `flock`): records the current sha, `git fetch`, `git reset --hard origin/$DEPLOY_REF`, installs at the repo root by lockfile (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `package-lock.json` → `npm ci`, none → skip), runs `apps/api`'s `build` script if it has one, restarts both units via the sudoers rule, polls `http://127.0.0.1:8000/health` for 30 s and on failure resets to the old sha, reinstalls, restarts and exits 1. It unsets all secrets before running install or build scripts. `apprentice-api` keeps answering `/health` with `runner:"down"` when the runner is down, so a missing Claude credential does not block deploys.

## Environment (`/etc/apprentice/env`)

| Variable | Used by | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY` | real API (B) | never sent to the browser |
| `CLAUDE_CODE_OAUTH_TOKEN` | runner | private development only (`claude setup-token`) |
| `ANTHROPIC_API_KEY` | runner | required for anything judges can reach; exactly one of the two |
| `RUNNER_TOKEN` | runner, API | `openssl rand -hex 32` |
| `API_TOKEN` | placeholder `/runner/*` test proxy | test aid; the browser never holds it |
| `ALLOWED_ORIGINS` | API | exact origins, comma-separated |
| `DATABASE_PATH` | real API | `/var/lib/apprentice/db/apprentice.sqlite` |
| `MEDIA_DIR` | real API | `/var/lib/apprentice/media` |
| `RUNNER_MODEL` | runner | default `claude-sonnet-5-5` |
| `RUNNER_CONCURRENCY` | runner | default 2 (about 1 GiB RAM per SDK subprocess) |
| `DEPLOY_REF` | deploy | default `main` |
| `DEBUG_ENDPOINTS` | placeholder | `1` enables `GET /debug/sse` |

## Contract for streams A and B: the real API (`apps/api`)

`start-api.sh` runs `node /opt/apprentice/repo/apps/api/dist/server.js` (cwd `apps/api`) as soon as that file exists after a deploy; otherwise the placeholder. The real server must:

- listen on `HOST` (`0.0.0.0`) and `PORT` (`8000`);
- read `DATABASE_PATH`, `MEDIA_DIR`, `RUNNER_URL` (`http://127.0.0.1:8787`), `RUNNER_TOKEN`, `ALLOWED_ORIGINS`, `ELEVENLABS_API_KEY` from the environment (systemd provides them; `GIT_SHA` is set too);
- serve `GET /health` → 200 with `{"ok": true, ...}` (deploy rolls back otherwise);
- handle its own CORS (exact match on `ALLOWED_ORIGINS`, `Vary: Origin`, answer `OPTIONS`);
- write only under `/var/lib/apprentice/{db,media}`; log metadata, never prompts, images, transcripts or keys.

## Runner API (`RUNNER_URL`, bearer `RUNNER_TOKEN`)

`GET /health` (no auth) → `{ok, mode: "oauth"|"apikey", model, git_sha, active, queued}`

`POST /v1/complete`
```json
{ "prompt": "string", "system": "optional string", "schema": { "optional JSON Schema draft-07": true }, "model": "optional" }
```
`POST /v1/vision`
```json
{ "images": [{ "media_type": "image/png|image/jpeg|image/gif|image/webp", "data": "<base64>" }], "prompt": "string", "system": "...", "schema": {}, "model": "..." }
```
1–4 images, sent to the SDK as streaming input (one `SDKUserMessage` with base64 image blocks then the text).

Success: `200 {ok: true, json, ms}` when `schema` was given (the SDK's `structured_output`), else `200 {ok: true, text, ms}`.

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ok:false, error:"invalid_json"\|"invalid_body", fields?}` | bad request (field paths only) |
| 401 | `{ok:false, error:"unauthorized"}` | missing or wrong bearer |
| 413 | `{ok:false, error:"body_too_large", max_bytes}` | body above 12 MiB |
| 429 | `{ok:false, error:"queue_full"}` + `Retry-After: 5` | `RUNNER_CONCURRENCY` busy and 10 already queued |
| 502 | `{ok:false, error:"sdk_error", subtype}` | SDK result not `success` (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`, `is_error`) |
| 502 | `{ok:false, error:"no_structured_output"\|"no_result"\|"sdk_exception"}` | no usable result; never an empty success |
| 504 | `{ok:false, error:"timeout", ms}` | 60 s run limit; the subprocess is aborted (`AbortController`) |

Every call: `tools: []`, `permissionMode: "dontAsk"`, `settingSources: []`, `persistSession: false`, `cwd: /var/lib/apprentice/runner-cwd`, `maxTurns: 3`, `maxBudgetUsd: 0.5`, a short custom system prompt (the request's `system` is appended), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The subprocess environment excludes `RUNNER_TOKEN`, `API_TOKEN` and `ELEVENLABS_API_KEY`. The runner refuses to start unless exactly one Claude credential is set and logs its mode at start. At boot it spawns and discards one warm subprocess (`startup()`), because per-request options differ.

The placeholder exposes the runner publicly as `POST /runner/v1/*` behind `Authorization: Bearer $API_TOKEN` for testing only.

## Measurements

Measured 3 Oct 2026 (oauth mode, `claude-sonnet-5-5`, concurrency 2, 2 vCPU / 7 GiB).

- Proxy (exe.dev, `check.sh` from a Mac against `https://apprentice.exe.xyz`): authenticated POSTs of 6, 8, 10 and **11.9 MB pass** (1.4–1.9 s upload), 13 MB gets 413 from our cap; SSE events arrive at +0.28, 1.23, 2.26, 3.23, 4.24 s (not buffered); preflight 204 with the origin echoed over HTTP/2, foreign origin gets no CORS header; `https://apprentice.exe.xyz:8787/health` → 307 to the exe.dev login (runner is loopback-only anyway). Recommended upload chunk for A's recording: **≤ 5 MB**.
- Public `/v1/complete` p50 2.9 s (3023 / 2620 / 2943 ms from Vienna); 5 parallel calls → 5 × 200.
- Free disk: 19 GB of 25 GB on `/`.
- `/v1/complete` with schema, 3 calls through :8000: 2353 / 2781 / 2890 ms, **p50 2.8 s**.
- `/v1/vision` (one 640×160 PNG) with schema, 3 calls: 2974 / 2469 / 2613 ms, **p50 2.6 s**.
- Sustained vision, 1 frame every 2 s for 60 s (30 calls, direct to the runner): 30 × 200, **p50 2.76 s, p95 3.77 s, max 3.96 s**, 0 failures; runner cgroup **peak memory 287 MiB**.
- Burst of 16 simultaneous vision calls: 12 × 200 (2 running + 10 queued), 4 × 429.
- Timeout (test override 1.5 s): 504 `timeout` after ~3.5 s (abort takes ~2 s), no SDK subprocess left.
- Unknown model: 502 `sdk_error` / `is_error`.
- After all runs: `customer_07` appears 0 times in journald, `~apprentice/.claude` and the runner cwd.

## Fast checks

```bash
cd infra/claude-runner && npm ci --include=optional && npm run typecheck
bash -n infra/*.sh infra/deploy/deploy.sh && node --check infra/placeholder-api/server.mjs
```
