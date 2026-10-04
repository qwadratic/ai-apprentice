# infra/ — VM backend on exe.dev (TASK-4)

Owner: TASK-4 (@qwadratic, delegated to the agent on the exe.dev VM). Nothing here is imported by `apps/` or `packages/`; streams A and B talk to it over HTTP only. The one piece of infra code that lives in `apps/api` is the `ops` module (`apps/api/ops/index.ts`, infra-owned), which puts the deploy webhook behind port 8000.

```
infra/
  claude-runner/      Claude runner (TypeScript, Agent SDK), 127.0.0.1:8787, own package-lock.json
  placeholder-api/    fallback public API, 0.0.0.0:8000 (TypeScript, no runtime deps, `node server.ts`); runs only while apps/api cannot start
  ops/                deploy webhook, 127.0.0.1:8788, reached through apps/api's ops module at /ops/* (TypeScript, no runtime deps)
  start-runner.sh     starts the runner from the deployed checkout
  start-api.sh        starts apps/api (`node server.ts`) when its sources and the root node_modules/express exist, else the placeholder
  systemd/            runner, api, ops units; deploy services, request path unit, optional timer; sudoers rule
  deploy/deploy.sh    deploy the published sha: build what changed, restart, health check, roll back
  install.sh          idempotent installer for the root-owned parts (sudo)
  check.sh            acceptance checks for apps/api on :8000 (local or through the public URL)
```

All code under `infra/` is TypeScript with `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `erasableSyntaxOnly`, and no `any` (`unknown` plus validators at the boundaries). The runner is built with `tsc`; the placeholder, ops and `apps/api` run through Node's built-in type stripping (**Node ≥ 22.18**; the VM has Node 24), so they need no build step (`typescript` and `@types/node` are dev-only, for `tsc --noEmit`). `apps/api` has runtime dependencies (Express) that come from the root `npm ci`.

## The public API: apps/api (since TASK-4.5)

Port 8000 is served by `apps/api` (Express 5, started by `start-api.sh` as `cd apps/api && node server.ts`), not by the placeholder any more. It mounts, in `apps/api/src/modules.ts`:

| Module | Owner | Routes |
|---|---|---|
| `agent` | stream B (`apps/api/agent`) | `/api/agent/sessions` (+ `/:id/events`, `/:id/finish`), `/api/agent/elevenlabs/signed-url`, admin `/agent/sessions` and `/api/agent/sessions` (list, read, delete; bearer `API_TOKEN`) |
| `ops` | infra (`apps/api/ops`) | every `/ops/*` request, forwarded raw to the deploy webhook; `GET /ops/vm-health` |
| `screen` | stream A | registered by A when its dependencies exist |

- `GET /health` is A's: `{ok: true, service, modules}`. The runner state and the shas that the placeholder put into `/health` are now at **`GET /ops/vm-health`** → `{ok, runner: "up"|"down", git_sha, deployed_sha}`: `runner` is a 2 s `GET RUNNER_URL/health`, `git_sha` the commit this process was started from (`GIT_SHA`, set by `start-api.sh`), `deployed_sha` the content of `DEPLOYED_SHA_FILE` (default `/var/lib/apprentice/deployed-sha`, written by deploy.sh; it can be newer than `git_sha` after a deploy that did not restart the API).
- **The ops module** (`apps/api/ops/index.ts`) forwards each `/ops/*` request to `OPS_URL` (default `http://127.0.0.1:8788`) with the method, path and query, the raw request bytes, `Content-Type` and `X-Deploy-Signature`, and `X-Forwarded-For` set to the client IP (the last `X-Forwarded-For` entry from the exe.dev proxy, else the socket address). The webhook checks an HMAC over the raw body, so the module reads the request stream itself: body limit 4 KiB (413), 60 s timeout, `502 {ok:false, error:"ops_unreachable"}` when the webhook is down. `createApi` installs `express.json` for every route; a JSON content type would be parsed before the module sees it and could not be forwarded byte for byte, so such a request is refused with **415** (never re-serialised). The signed deploy request must therefore be sent as `Content-Type: application/octet-stream`, which is what `release.yml` does. The global CORS rule of `createApi` applies in front: a browser `Origin` that is not in `ALLOWED_ORIGINS` gets 403.
- **Retired lab routes.** The placeholder's `GET /agent/elevenlabs/signed-url` and `POST /agent/sessions/:id/events|finish` (browser routes without a session token) are gone: the lab is retired and the agent module's token-protected `/api/agent/*` routes replace them. Both now answer 404. The admin routes `GET /agent/sessions`, `GET|DELETE /agent/sessions/:id` remain (bearer `API_TOKEN`, same shapes as before; `check.sh` uses them).
- **Also gone with the placeholder:** `POST /runner/v1/*` (the public test proxy for the runner) and `GET /debug/sse`. The runner is reached only by server code through `RUNNER_URL` + `RUNNER_TOKEN`; test it on the VM with `curl -s localhost:8787/health` and, with `Authorization: Bearer $RUNNER_TOKEN`, `POST localhost:8787/v1/complete`.
- **Fallback.** `start-api.sh` runs the placeholder only when `apps/api/src/modules.ts` or the root `node_modules/express` is missing (for example a checkout from before the switch, which a rollback restores). The placeholder keeps its own `/health`, `/ops/*` and lab routes; it is not served in normal operation.

`infra/` uses **npm**, not the root package manager, and must never match a root workspace glob (keep `pnpm-workspace.yaml` / `workspaces` to `apps/*` and `packages/*`).

## Host

| | |
|---|---|
| Public URL | `https://apprentice.exe.xyz` → VM port **8000** (only public port) |
| Runner | `http://127.0.0.1:8787` (loopback only; bearer `RUNNER_TOKEN`) |
| Code | `/opt/apprentice/repo`: anonymous clone, detached at the deployed sha; the services run from it and only `deploy.sh` moves it. `/opt/apprentice/bin/apprentice-deploy`: the deploy script, installed by `install.sh` |
| Data | `/var/lib/apprentice/{db,media,runner-cwd,sessions}`, owner `apprentice`, mode 750; survives restarts and reboots |
| Secrets | `/etc/apprentice/env`, root:root 0600, loaded by systemd `EnvironmentFile=` |
| OS | Ubuntu 24.04, systemd 255, Node 24 LTS, pnpm via corepack |

## Manual steps for Ivan

1. Make the proxy public (from your machine; `ssh exe.dev` does not work from inside the VM):
   ```
   ssh exe.dev share set-public apprentice
   ssh exe.dev share port apprentice 8000     # only if the public port is not already 8000
   ```
   Without `set-public` every public request is redirected to the exe.dev login.
2. Fill the secrets on the VM: `sudoedit /etc/apprentice/env` — `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID_INTERVIEWER`, exactly **one** of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, and `ALLOWED_ORIGINS` (it must contain the exact origin of the web app, for example `https://qwadratic.github.io`; apps/api answers 403 to any other browser origin). Then `sudo systemctl restart apprentice-runner apprentice-api`.
3. **Before any judge-facing URL is shared:** switch to API-key auth (Agent SDK terms): set `ANTHROPIC_API_KEY`, delete the `CLAUDE_CODE_OAUTH_TOKEN` value, restart, and confirm `mode` is `apikey`:
   `curl -s localhost:8787/health | jq .mode`.
4. Deploys are pushed by GitHub Actions (`release.yml` signs a request to `POST /ops/deploy`, see below); the secret `DEPLOY_WEBHOOK_SECRET` is in `/etc/apprentice/env` and in the repository's Actions secrets. To rotate it: generate a new one into the env file (`sudoedit`), `sudo systemctl restart apprentice-ops`, and set the same value with `gh secret set DEPLOY_WEBHOOK_SECRET -R qwadratic/ai-apprentice` (it reads stdin). The minute timer (`DEPLOY_SOURCE=pages`) is an optional fallback: `sudo systemctl enable --now apprentice-deploy.timer`. To freeze before the pitch, set `DEPLOY_FREEZE=1` in the repository so `release.yml` neither publishes nor calls the webhook.
5. After a deploy logs `not applied, run sudo infra/install.sh`: on the VM, `cd ~/work/ai-apprentice && git fetch && git checkout --detach <sha from the log> && sudo infra/install.sh`.

## Operations

```bash
# deploy now (reads /etc/apprentice/env, so DEPLOY_SOURCE applies; logs in journald)
sudo systemctl start apprentice-deploy.service
sudo journalctl -u apprentice-deploy -n 50
# the same script by hand; --force rebuilds and restarts everything
sudo -u apprentice /opt/apprentice/bin/apprentice-deploy [--force]
# install or update the root-owned parts from a clone (idempotent)
sudo ~/work/ai-apprentice/infra/install.sh
# logs (metadata only: request id, route, status, duration, sizes, model)
sudo journalctl -u apprentice-api -u apprentice-runner -f
systemctl list-timers apprentice-deploy.timer
# acceptance checks on the VM (through port 8000)
~/work/ai-apprentice/infra/check.sh
```

### Running the checks from a Mac (through the public proxy)

```bash
brew install jq                      # once; curl ships with macOS
T=$(ssh apprentice.exe.xyz "sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2") \
  BASE=https://apprentice.exe.xyz bash <(ssh apprentice.exe.xyz cat work/ai-apprentice/infra/check.sh)
```

The token goes only into the environment of that one command and into a 0600 header file for curl, so it is never printed and never visible in `ps`; the check session it creates is deleted at the end (its token expires on its own after 12 h). A few seconds, no model calls. It checks: `/health` (ok, agent and ops modules); CORS preflight for an allowed and a foreign origin; `/ops/deploy/status` and `/ops/vm-health` through port 8000; `POST /api/agent/sessions` from the allowed origin (201 with a token, 403 from a foreign one); events with that token (200), without it (401), with another session's token (403), over the size limits (413); the signed-URL route; the retired lab routes (404); the admin routes with `API_TOKEN`; and the deploy webhook (JSON content type 415, unsigned or wrongly signed 401, over 4 KiB 413 and, when `DEPLOY_WEBHOOK_SECRET` is set, a signed redeploy of the deployed sha and its replay 409).

### How a commit reaches the VM

1. `release.yml` checks `main`; if green and not frozen it publishes the site (and `deploy.json`) to Pages and then calls the deploy webhook with the same sha, polling `GET /ops/deploy/status` until `ok`, `failed` or `rolled_back`, so the result shows in the Actions UI.
2. **Webhook** (`infra/ops`, `apprentice-ops.service`, 127.0.0.1:8788; the ops module of apps/api forwards `/ops/*` to it with the raw body):
   - `POST /ops/deploy` with body `{"sha": "<40 hex>", "ts": <unix seconds>}` and header `X-Deploy-Signature: sha256=<hex HMAC-SHA256(DEPLOY_WEBHOOK_SECRET, raw body)>`. Checks, in order: secret configured (503), body ≤ 1 KiB (413), signature, compared timing-safe (401 `bad_signature`; only failed signatures count against the rate limit of 6/min per IP and 30/h overall, 429, so unsigned noise cannot block real deploys), body shape (400), `ts` not older than 300 s nor more than 60 s ahead (401 `timestamp_out_of_window`), the same signature not seen before (409 `replayed`), sha an ancestor of `origin/main` after a fetch (422 `not_on_main`). Then it writes `/var/lib/apprentice/deploy-request.json` and `deploy-status.json` (`queued`) and answers **202** `{accepted: true, sha}`. Bodies and signatures are never logged.
   - `GET /ops/deploy/status` (public, no secrets) → `{deployed_sha, last: {sha, state: queued|running|ok|failed|rolled_back, source, started_at, finished_at, message}}`.
   - Signing in a workflow (the body string must be sent byte for byte as signed):
     ```bash
     body=$(jq -cn --arg sha "$GITHUB_SHA" --argjson ts "$(date +%s)" '{sha: $sha, ts: $ts}')
     sig=$(BODY="$body" node -e 'process.stdout.write(require("crypto").createHmac("sha256", process.env.DEPLOY_WEBHOOK_SECRET).update(process.env.BODY).digest("hex"))')
     curl -fsS -X POST https://apprentice.exe.xyz/ops/deploy -H 'Content-Type: application/octet-stream' -H "X-Deploy-Signature: sha256=$sig" --data-raw "$body"
     ```
3. `apprentice-deploy-request.path` sees the request file change and starts `apprentice-deploy-request.service` (`apprentice-deploy --request`, as `apprentice`, no sudo needed by the webhook). It waits for a running deploy (lock), checks the sha again (40 hex, on `origin/main`), and after finishing looks once more in case a newer request arrived meanwhile.
4. The deploy:
   - logs changed install-managed paths (`infra/systemd`, `infra/install.sh`, `infra/deploy`) with `run sudo infra/install.sh` and never applies them;
   - checks the sha out detached and runs `git clean -fdx`, keeping every `node_modules`, the runner's `dist` and `apps/api/dist`; those are rebuilt (dist removed first) when their sources change;
   - rebuilds only what changed: the runner (`npm ci` + `tsc`) when `infra/claude-runner` or `start-runner.sh` changed, and the API side when `apps/`, `packages/`, `infra/placeholder-api`, `start-api.sh` or a root package or lockfile changed. The API side means the root `npm ci` (this puts `node_modules/express` where `start-api.sh` looks for it), the build of `@apprentice/contracts` (its `dist/` is gitignored, so the checkout's `git clean` removes it, and apps/api type-checks against it), and `npm run build` in `apps/api`, which is a strict no-emit type check because apps/api runs from source; the placeholder and ops need nothing, since they have no runtime dependencies. So a change under `apps/` or `packages/` always means: root install, contracts build, type check, restart of `apprentice-api`;
   - restarts only those services (`infra/ops` changes restart `apprentice-ops`);
   - health-checks for 30 s: `/health` must say `ok: true` (apps/api: `{ok, service, modules}`) **and** `/ops/deploy/status` must answer through port 8000, so an API that crashes, fails to start or stops forwarding `/ops/*` is rolled back;
   - records the sha in `/var/lib/apprentice/deployed-sha`.
5. Progress goes to `deploy-status.json` (`running`, then `ok`, `rolled_back` or `failed`). A request for the deployed sha ends as `ok` / `already deployed`.
6. The base for diffs, "already deployed" and rollback is the last sha that passed its health check (`deployed-sha`), not HEAD; if HEAD differs (an interrupted deploy), everything is rebuilt. Every install or build step has a 10 min timeout, git transfers fail when stalled for 30 s, and the deploy services have a 30 min start timeout.
7. On failure it checks the last deployed sha out, rebuilds what differs, restarts, and records the failed sha. Manual and timer runs skip it until a new sha comes or `--force` is given; a signed webhook request for it is an explicit retry.

The deploy that switched port 8000 from the placeholder to apps/api (TASK-4.5) is an ordinary deploy of its commit: `apps/` and `infra/start-api.sh` changed, so it runs the root `npm ci`, type-checks `apps/api`, restarts `apprentice-api`, and rolls back to the previous commit (and so to the placeholder) if `/health` or `/ops/deploy/status` do not answer within 30 s. `deploy.sh`, the units and `install.sh` are not applied by a deploy (`sudo infra/install.sh`); this change touches none of them.

Other sources, for manual use: `sudo systemctl start apprentice-deploy.service` deploys from `DEPLOY_SOURCE` (`pages`: the sha in `deploy.json`; `ref`: `origin/$DEPLOY_REF`); the optional minute timer runs that same service. A backlog-only or docs-only release moves the checkout and `deployed_sha` but restarts nothing. `apprentice-api` keeps answering `/health` when the runner is down (`GET /ops/vm-health` then says `runner: "down"`), so a missing Claude credential does not block deploys.

**Security notes on deploy:**
- `pnpm install` / `npm ci` run the dependencies' install lifecycle scripts as `apprentice`, the same user the services run as. deploy.sh unsets the secrets in its own environment, but a malicious dependency could still read the service processes' environment or `/var/lib/apprentice` data. Review new dependencies before they land on `main`.
- Every release that touches the API's paths restarts `apprentice-api`, and live sessions drop; backlog- or docs-only releases restart nothing. **Freeze releases (`DEPLOY_FREEZE=1`) during the pitch.**
- The webhook can only deploy commits already on `main`, and only with a valid signature; a leaked secret lets someone redeploy an older `main` commit, nothing else. Rotate it as in Manual steps 4.

## Environment (`/etc/apprentice/env`)

| Variable | Used by | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY` | agent module | never sent to the browser |
| `ELEVENLABS_AGENT_ID_INTERVIEWER` | agent module (signed URL, finish) | interviewer agent id from stream B's ElevenLabs spike; empty → 503 |
| `ELEVENLABS_AGENT_ID_TUTOR` | agent module (finish) | optional; the tutor agent's conversations may be stored too |
| `CLAUDE_CODE_OAUTH_TOKEN` | runner | private development only (`claude setup-token`) |
| `ANTHROPIC_API_KEY` | runner | required for anything judges can reach; exactly one of the two |
| `RUNNER_TOKEN` | runner, API | `openssl rand -hex 32` |
| `API_TOKEN` | agent module admin routes (`/agent/sessions`), `check.sh` | at least 32 characters, else the admin routes are off; the browser never holds it |
| `ALLOWED_ORIGINS` | API | exact origins, comma-separated; a browser request from any other `Origin` gets 403 |
| `OPS_URL` | ops module | the deploy webhook, default `http://127.0.0.1:8788` |
| `DEPLOYED_SHA_FILE` | ops module (`/ops/vm-health`) | default `/var/lib/apprentice/deployed-sha` |
| `DATABASE_PATH` | real API | `/var/lib/apprentice/db/apprentice.sqlite` |
| `MEDIA_DIR` | real API | `/var/lib/apprentice/media` |
| `RUNNER_MODEL` | runner | default `claude-sonnet-5-5` |
| `RUNNER_MODELS` | runner | optional allowlist for a request's `model` (default sonnet-5-5, opus-5-5, haiku-4-5); others get 400 `model_not_allowed` |
| `RUNNER_CONCURRENCY` | runner | default 2 (about 1 GiB RAM per SDK subprocess) |
| `RUNNER_ENGINE`, `RUNNER_CODEX_MODEL`, `RUNNER_CODEX_REASONING`, `RUNNER_CODEX_EPHEMERAL`, `RUNNER_CODEX_BIN` | runner | `RUNNER_ENGINE=codex` runs requests through the Codex CLI; see "Codex engine" |
| `DEPLOY_WEBHOOK_SECRET` | ops | HMAC key for `POST /ops/deploy`; the same value is the Actions secret `DEPLOY_WEBHOOK_SECRET` |
| `DEPLOY_SOURCE` | deploy | `pages` (default): the sha in `deploy.json`; `ref`: `origin/$DEPLOY_REF` |
| `DEPLOY_REF` | deploy | default `main`; used with `DEPLOY_SOURCE=ref` |
| `DEPLOY_JSON_URL` | deploy | default `https://qwadratic.github.io/clipa/deploy.json` |
| `SESSIONS_DIR` | agent module | default `/var/lib/apprentice/sessions` (not in the env file; set in the unit if needed) |
| `SIGNED_URL_REQUIRE_SESSION`, `AGENT_*`, `SIGNED_URL_*`, `EVENTS_BYTES_PER_HOUR`, `SESSIONS_WARN_BYTES`, `SESSIONS_ROTATE_BYTES` | agent module | session-token requirement for the signed URL, rate limits and disk thresholds, all optional; see `apps/api/agent/config.ts` |
| `DEBUG_ENDPOINTS` | placeholder only | `1` enables `GET /debug/sse`; ignored by apps/api |

## Contract for streams A and B: the real API (`apps/api`)

`start-api.sh` runs `cd /opt/apprentice/repo/apps/api && node server.ts` (type stripping, no build output) when `apps/api/src/modules.ts` and the root `node_modules/express` exist; otherwise the placeholder. `apps/api` must:

- listen on `HOST` (`0.0.0.0`) and `PORT` (`8000`);
- read `DATABASE_PATH`, `MEDIA_DIR`, `RUNNER_URL` (`http://127.0.0.1:8787`), `RUNNER_TOKEN`, `ALLOWED_ORIGINS`, `ELEVENLABS_API_KEY` from the environment (systemd provides them; `GIT_SHA` is set too);
- serve `GET /health` → 200 with `{"ok": true, ...}` (deploy rolls back otherwise) and keep the `ops` module registered: deploy's health check requires `/ops/deploy/status` through port 8000, so an API that loses it is rolled back;
- handle its own CORS (`createApi`: exact match on `ALLOWED_ORIGINS`, 403 for other origins, answers `OPTIONS`);
- write only under `/var/lib/apprentice/{db,media,sessions}`; log metadata, never prompts, images, transcripts or keys.

A module that needs the raw request bytes (a signature over the body, like the ops module) cannot rely on `express.json`, which `createApi` installs for every route: it only skips other content types.

## Runner API (`RUNNER_URL`, bearer `RUNNER_TOKEN`)

`GET /health` (no auth) → `{ok, mode: "oauth"|"apikey"|"codex", model, git_sha, active, queued}`

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

Structured output takes one object schema at the root: a schema whose root is a union (`oneOf`, `anyOf` or `allOf`, as A's vision schema is) comes back from the SDK as `502 sdk_error / is_error` within about 1.5 s, while the same union nested under an object property works (measured on the VM, 4 Oct). The runner therefore sends such a schema as `{type: "object", required: ["result"], additionalProperties: false, properties: {result: <schema>}}` and returns the unwrapped `result`, so `json` always has the shape of the client's own schema (`src/schema.ts`, TASK-4.7). Other schemas pass through unchanged.

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ok:false, error:"invalid_json"\|"invalid_body", fields?}` | bad request (field paths only) |
| 400 | `{ok:false, error:"model_not_allowed", allowed}` | `model` not in the allowlist |
| 401 | `{ok:false, error:"unauthorized"}` | missing or wrong bearer |
| 413 | `{ok:false, error:"body_too_large", max_bytes}` | body above 12 MiB |
| 429 | `{ok:false, error:"queue_full"}` + `Retry-After: 5` | `RUNNER_CONCURRENCY` busy and 10 already queued |
| 502 | `{ok:false, error:"sdk_error", subtype}` | SDK result not `success` (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`, `is_error`) |
| 502 | `{ok:false, error:"no_structured_output"\|"no_result"\|"sdk_exception"}` | no usable result; never an empty success |
| 504 | `{ok:false, error:"timeout", ms}` | 60 s run limit; the subprocess is aborted (`AbortController`) |

Every call: `tools: []`, `permissionMode: "dontAsk"`, `settingSources: []`, `persistSession: false`, `cwd: /var/lib/apprentice/runner-cwd`, `maxTurns: 3`, `maxBudgetUsd: 0.5`, a short custom system prompt (the request's `system` is appended), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The subprocess environment excludes `RUNNER_TOKEN`, `API_TOKEN` and `ELEVENLABS_API_KEY`. The runner refuses to start unless exactly one Claude credential is set and logs its mode at start. At boot it spawns and discards one warm subprocess (`startup()`), because per-request options differ. A queued request whose client disconnected is dropped before it runs (logged as 499). `x-request-id` is used for logs only if it matches `[A-Za-z0-9._-]{1,64}`. The unit runs with `ProtectSystem=strict` (writable: the runner cwd and `/home/apprentice`) and `MemoryMax=2560M`.

The placeholder used to expose the runner publicly as `POST /runner/v1/*` for testing; apps/api does not. On the VM: `curl -s localhost:8787/health`, and `curl -s -X POST localhost:8787/v1/complete -H "Authorization: Bearer $RUNNER_TOKEN" -H "Content-Type: application/json" -d '{"prompt":"ping"}'` (take the token from `/etc/apprentice/env` without printing it).

## Codex engine (`RUNNER_ENGINE=codex`)

A second engine for when the Claude credentials have no quota: every `/v1/complete` and `/v1/vision` request runs the OpenAI Codex CLI (`codex exec`, logged in with a ChatGPT account) as a subprocess instead of the Agent SDK (`src/codex.ts`). The HTTP contract, the concurrency limit, the queue and `RUNNER_TIMEOUT_MS` are the same. With `codex` the Claude credential check is skipped, no warm SDK subprocess is started, and `/health` reports `mode: "codex"` and `model` = `RUNNER_CODEX_MODEL` or `codex-default`.

The command (prompt on **stdin**, never in argv; schema, images and the answer file in a per-request temp dir under the runner cwd, removed after every call; the CLI runs inside that dir):

```
codex exec --skip-git-repo-check --sandbox read-only [--ephemeral] [-m $RUNNER_CODEX_MODEL] -c model_reasoning_effort="low" \
  [--output-schema <tmp>/schema.json] -o <tmp>/answer.txt [-i <tmp>/image-1.png ...]   < prompt
```

The prompt is `<system>` + the runner's system text + the request's `system`, then the request's `prompt`. The request's `model` (a Claude name) is still checked against `RUNNER_MODELS` but not used. Schemas go through the root-union wrapper and then `toCodexSchema`, which makes them OpenAI strict-mode schemas: every property listed in `required` (an optional one becomes `anyOf [<schema>, null]`, and such a `null` is removed from the answer again), `additionalProperties: false` on every object, `oneOf` → `anyOf`, `const` → one-value `enum`, and these keywords dropped: `minLength`, `maxLength`, `pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `default`, `examples`, `$schema`. That is safe because the API validates every answer with its own parsers.

Outcomes: CLI past the timeout → its process group is killed, `504 timeout`; non-zero exit → `502 sdk_error / codex_exit`; binary missing → `502 sdk_exception / codex_spawn`; answer not JSON (with a schema) → `502 no_structured_output`; empty answer (no schema) → `502 no_result`. The CLI's stdout and stderr are discarded, never logged.

| Variable | Default | |
|---|---|---|
| `RUNNER_ENGINE` | `claude` | `codex` switches the engine |
| `RUNNER_CODEX_MODEL` | unset | passed as `-m` only when set; else the CLI's configured model |
| `RUNNER_CODEX_REASONING` | `low` | `model_reasoning_effort` override; empty leaves the CLI's setting |
| `RUNNER_CODEX_EPHEMERAL` | unset | `1` adds `--ephemeral` (no session files with prompts under `~/.codex/sessions`); only for a CLI version that has the flag |
| `RUNNER_CODEX_BIN` | `codex` | absolute path when the binary is not on the unit's `PATH` (`/usr/local/bin:/usr/bin:…`) |
| `CODEX_HOME` | `~/.codex` of the service user | where the CLI keeps `auth.json` |

**Switch on the VM** (the runner runs as `apprentice`, so the CLI needs that user's login):
```
sudo install -d -o apprentice -g apprentice -m 700 /home/apprentice/.codex
sudo install -o apprentice -g apprentice -m 600 /home/exedev/.codex/auth.json /home/apprentice/.codex/auth.json
sudoedit /etc/apprentice/env          # add: RUNNER_ENGINE=codex
sudo systemctl restart apprentice-runner
curl -s localhost:8787/health          # → "mode":"codex"
```
`/home/apprentice` is writable for the unit (`ReadWritePaths`), so the CLI can refresh its tokens there. `codex` must be on the unit's `PATH` and readable by `apprentice` (check: `sudo -u apprentice -H bash -c 'command -v codex && codex --version'`); if it lives under another user's home, set `RUNNER_CODEX_BIN` to a path `apprentice` can run. Then one real call: `curl -s -X POST localhost:8787/v1/complete -H "Authorization: Bearer $RUNNER_TOKEN" -H "Content-Type: application/json" -d '{"prompt":"ping"}'` (token from the env file without printing it) and `sudo journalctl -u apprentice-runner -n 5`.

**Switch back:** remove the `RUNNER_ENGINE` line (or set `claude`), `sudo systemctl restart apprentice-runner`, check that `mode` is `oauth` or `apikey`.

**Limits.** Latency: one trivial structured call took about 9 s on the VM (codex-cli 0.159.0, ~14k tokens of reasoning before the effort override), several times the Agent SDK's ~2.8 s, so the vision loop gets far fewer frames per minute, and `RUNNER_TIMEOUT_MS` (60 s) may need raising for big map synthesis prompts. Images use `-i`; a CLI version without it fails every vision call with `sdk_error / codex_exit`. Spend counts against the ChatGPT account's Codex limits.

**Flags and their sources.** From the `codex exec` reference (https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-exec, formerly developers.openai.com/codex/cli/reference) and the non-interactive guide (https://learn.chatgpt.com/docs/non-interactive-mode): `exec`, `--skip-git-repo-check`, `--sandbox read-only`, `--ephemeral`, `-m/--model`, `-c/--config key=value`, `--output-schema`, `-o/--output-last-message`, `-i/--image` (repeatable), and the prompt read from stdin when no prompt argument is given. Checked on the VM with codex-cli 0.159.0: `exec --skip-git-repo-check --sandbox read-only --output-schema … -o …` with the prompt as an argument. **Not verified:** the config key `model_reasoning_effort` and its value `low` on 0.159.0, `-i` on 0.159.0, `--ephemeral` on 0.159.0 (off by default for that reason), the stdin prompt on 0.159.0, and which strict-mode keywords the ChatGPT backend accepts (the converter drops all doubtful ones).

## Agent module storage (stream B, `apps/api/agent`)

The routes, their status codes and rate limits are in `apps/api/agent` (`routes.ts`, `admin.ts`, `config.ts`, tests in `apps/api/test/agent-*.test.ts`); they are not repeated here. What matters for operations:

- **Files** in `/var/lib/apprentice/sessions` (apprentice, 750), the same layout the placeholder used: `{sessionId}.jsonl` (events), `{sessionId}.conv` (the conversationId the session is bound to), `{sessionId}.elevenlabs.json` (conversation from ElevenLabs), `{sessionId}.{mp3,wav,ogg,webm,m4a,aac}` (audio), and `agent-sessions.json` (0600: the session tokens, stored as hashes; live sessions survive a restart).
- **Disk:** checked after a write and every 10 minutes. Orphaned `*.tmp` files older than 10 min are removed; above 1 GiB the API logs `sessions dir over warn threshold` and the admin listing shows `warn: true`; above 2 GiB it deletes the oldest sessions down to 1.5 GiB (`sessions rotated`), never sessions newer than 24 h. Check usage with `sudo du -sh /var/lib/apprentice/sessions` or `sudo journalctl -u apprentice-api | grep -E 'warn threshold|rotated|over cap'`.
- **Admin routes** (`Authorization: Bearer $API_TOKEN`, else 401): `GET /agent/sessions` (`{ok, total_bytes, warn, sessions: [{id, size, mtime, hasEvents, hasTranscript, hasAudio}]}`, newest first), `GET /agent/sessions/{id}` (events, transcript, audio info), `DELETE /agent/sessions/{id}`; the same under `/api/agent/sessions`.
- **Browser routes need a session token:** `POST /api/agent/sessions` (an allowed `Origin`) issues `{sessionId, token, ...}`; `/api/agent/sessions/{id}/events` and `/finish` take `Authorization: Bearer <token>` for that session. The placeholder's tokenless lab routes (`/agent/elevenlabs/signed-url`, `/agent/sessions/{id}/events`, `/agent/sessions/{id}/finish`) no longer exist.
- Logs never contain bodies, transcripts, audio, tokens, keys or signed URLs.

## Measurements

Measured 3 Oct 2026 (oauth mode, `claude-sonnet-5-5`, concurrency 2, 2 vCPU / 7 GiB), when the placeholder served port 8000 (its `/runner/*` test proxy and `check.sh` of that time; neither exists after TASK-4.5).

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
npm ci && npm run check                                        # repo root: apps/api (incl. the ops module tests), web, packages
(cd infra/claude-runner && npm ci --include=optional && npm run typecheck && npm test)
(cd infra/placeholder-api && npm ci && npm run typecheck)      # tsc --noEmit
(cd infra/ops && npm ci && npm run typecheck)                  # tsc --noEmit
bash -n infra/*.sh infra/deploy/deploy.sh
```

The ops module's tests (`apps/api/test/ops.test.ts`) use a fake webhook and a fake runner. The release job's signing snippet can be tried against a local pair of processes: `infra/ops/server.ts` (`OPS_PORT`, `DEPLOY_WEBHOOK_SECRET`, `DEPLOY_REPO` = a clone whose `origin/main` contains the sha, `DEPLOY_STATE_DIR` = a temp dir) and `node server.ts` in `apps/api` with `PORT`, `OPS_URL` pointing at that webhook: a signed `POST /ops/deploy` as `application/octet-stream` answers 202, the same request again 409, and `GET /ops/deploy/status` 200.
