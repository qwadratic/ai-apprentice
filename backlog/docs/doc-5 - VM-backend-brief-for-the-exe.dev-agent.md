---
id: doc-5
title: VM backend brief for the exe.dev agent
type: guide
created_date: '2026-10-03 21:11'
---


You run ON an exe.dev VM that Ivan (@qwadratic) created beforehand (`ssh exe.dev new --name apprentice`). Goal: a public HTTPS backend host for https://github.com/qwadratic/ai-apprentice (public, MIT, hackathon deadline Sun 4 Oct 2026 10:00 CEST) with a Claude "runner" service, a deploy script and room for SQLite and media files. Prefer working over perfect. Report after each step.

**Read first:** `AGENTS.md`, `backlog/docs/doc-1 - Parallel-work-rules.md`, then the tasks: `backlog/tasks/task-4 - *.md` (TASK-4), TASK-4.1 (steps 1, 3-6: VM, placeholder API, deploy) and TASK-4.2 (step 2: Claude runner). Their acceptance criteria and the checks below are the definition of done.

## Ownership
- You own only `infra/` (create it) and the VM itself. Never edit `apps/`, `packages/`, `fixtures/`, `backlog/`, the root `package.json` or lockfile. Stream A (@kigulx) owns the skeleton and lockfile; stream B (@qwadratic) owns `apps/api/agent`. No ElevenLabs, signed-URL or Work Map logic here.
- Put `TASK-4` in commit messages. You cannot push and do not use the `backlog` CLI; Ivan updates the task from your report.

## Layout
- `~/work/ai-apprentice`: your clone, branch `infra/vm-backend`. All edits happen here.
- `/opt/apprentice/infra`: copy installed by `infra/install.sh`; the units run from here.
- `/opt/apprentice/repo`: anonymous clone of `main`. Only `deploy.sh` touches it (`reset --hard` is safe because none of your work is in it).
- `/var/lib/apprentice/{db,media,runner-cwd}`, owner `apprentice`, mode 750.

## Security rules (non-negotiable)
- No secrets in git, logs, command output or chat. Never use `--env` for secrets. Never `set -x`. Do not ask Ivan to paste secrets: create `/etc/apprentice/env` (root:root, 600, systemd `EnvironmentFile=`) with empty placeholders and tell him to run `sudoedit /etc/apprentice/env`.
- Variables: `ELEVENLABS_API_KEY`, exactly one of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, `RUNNER_TOKEN` and `API_TOKEN` (generate with `openssl rand -hex 32`), `ALLOWED_ORIGINS` (exact origins, comma-separated), `DATABASE_PATH`, `MEDIA_DIR`, `RUNNER_MODEL` (default `claude-sonnet-5-5`), `RUNNER_CONCURRENCY` (default 2), `DEPLOY_REF` (default `main`), `DEBUG_ENDPOINTS`.
- Services run as `apprentice`, not root. The runner listens on `127.0.0.1:8787` and requires `Authorization: Bearer $RUNNER_TOKEN`. Only port 8000 is public. Note: exe.dev forwards ports 3000-9999 to exe.dev-authenticated users, so the runner token stays mandatory.
- Logs: request id, route, status, duration, byte sizes, model. Never prompts, images, outputs or SDK stderr.
- Synthetic data only.

## Auth caveat
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is for private development only. Anthropic's Agent SDK terms say third-party products must use API-key auth, so anything judges can reach must run on `ANTHROPIC_API_KEY`. Switch = set the key, delete the token, restart. The runner logs its mode (`oauth`/`apikey`) at start, shows it in `/health`, and refuses to start if both or neither are set. Never pass `--bare` (it ignores the OAuth token). Not verified by anyone: that the token works with the SDK on this image; the first vision call tests it.

## Steps (confirm syntax with `ssh exe.dev help share` and `ssh exe.dev help new`; docs were read through a summarizer)

**1. Provision.** Check `systemctl --version`. Install the current Active LTS Node (check nodejs.org), corepack/pnpm, git, jq, curl, ImageMagick, sqlite3. Create user `apprentice`. Create the layout above. If `ssh exe.dev` does not work from the VM, print for Ivan: `ssh exe.dev share set-public apprentice` and, if the public port is not 8000, `ssh exe.dev share port apprentice 8000`. Without `set-public` every public call is redirected to an exe.dev login.

**2. Claude runner**, `infra/claude-runner/` (TypeScript, `@anthropic-ai/claude-agent-sdk` latest, `zod@4`; own `package.json` and `package-lock.json`, installed with npm and optional dependencies, since the SDK needs its native binary).
- `GET /health` (no auth): `{ok, mode, model, git_sha}`.
- `POST /v1/complete` `{prompt, system?, schema?, model?}` and `POST /v1/vision` `{images:[{media_type,data}] (max 4), prompt, system?, schema?, model?}` return `{ok, text?, json?, ms}`. Vision uses streaming input (`AsyncIterable<SDKUserMessage>` with base64 image blocks).
- `schema` = JSON Schema draft-07 as `outputFormat`. Use `structured_output` only if `subtype==='success'`, else 502 with the subtype. Wrap `query()` in try/catch.
- Options on every call: `tools: []`, `permissionMode: 'dontAsk'`, `settingSources: []`, `persistSession: false`, `cwd: /var/lib/apprentice/runner-cwd`, `maxTurns: 3` (raise if `error_max_turns` appears), `maxBudgetUsd: 0.5`, a short custom `systemPrompt`, `env: {...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'}` (this option replaces the environment). No Bash/Write/Read.
- Limits: `RUNNER_CONCURRENCY` semaphore (about 1 GiB RAM per subprocess), queue of 10 then 429, 60 s run timeout then 504 with `AbortController` so the subprocess is killed, body above 12 MB gives 413. Call `startup()`/prewarm at boot if the SDK offers it. Log first-result latency.
- Optional, only if time remains: `LLM_BACKEND=messages` using `@anthropic-ai/sdk` (needs an API key; faster for per-frame vision).

**3. Public API placeholder**, `infra/placeholder-api/` (dependency-free Node `http`), `0.0.0.0:8000`.
- `GET /health` gives `{ok, runner:'up'|'down', git_sha}`.
- CORS: reflect `Origin` only on exact match with `ALLOWED_ORIGINS`, with `Vary: Origin`; `OPTIONS` returns 204 with `Access-Control-Allow-Headers: Authorization, Content-Type` and `Allow-Methods`. Request body cap 12 MB.
- `/runner/*` proxies to the runner and needs `Authorization: Bearer $API_TOKEN`. It is a test aid only; the browser never holds this token.
- With `DEBUG_ENDPOINTS=1`, `GET /debug/sse` sends 5 events, one per second.
- `start-api.sh` runs `/opt/apprentice/repo/apps/api/dist/server.js` if it exists, else the placeholder.

**4. systemd and deploy.**
- `infra/install.sh` (idempotent, run by you with sudo) copies `infra/` to `/opt/apprentice/infra`, installs units `apprentice-runner.service` and `apprentice-api.service` (`Restart=always`, enabled, `NoNewPrivileges=true` on these two only, logs to journald) and a sudoers file allowing `apprentice` exactly `systemctl restart apprentice-runner.service` and `... apprentice-api.service`.
- `infra/deploy/deploy.sh`, run as `apprentice` under `flock`, working in `/opt/apprentice/repo`: record sha; `git fetch`; `git reset --hard origin/$DEPLOY_REF`; install at the root with the package manager the lockfile implies (`pnpm-lock.yaml` gives `pnpm install --frozen-lockfile`, `package-lock.json` gives `npm ci`, none gives skip); if `apps/api/package.json` has a `build` script, run it; restart both units via sudo; poll `http://127.0.0.1:8000/health` for 30 s; on failure reset to the old sha, reinstall, restart, exit 1.
- `apprentice-deploy.service` (must NOT set NoNewPrivileges) plus `apprentice-deploy.timer` (every 1 min), created DISABLED. Document the enable command in `infra/README.md`.
- `infra/README.md` must also state the contract for streams A and B: real API reads `PORT`, `HOST`, `DATABASE_PATH`, `MEDIA_DIR`, `RUNNER_URL=http://127.0.0.1:8787`, `RUNNER_TOKEN`, serves `GET /health`, and handles its own CORS; runner request/response shapes; note that `infra/` uses npm and must not match a root workspace glob.
- Commit on `infra/vm-backend` and save `git format-patch main..infra/vm-backend -o ~/handoff`. Ivan applies it with `git am` and pushes.

**5. Proxy behaviour.** Through the public URL, measure and report exact results: 6 MB POST to `/runner/v1/vision` is not rejected by the proxy; `/debug/sse` events arrive one per second; CORS preflight. If any fails, report the failure before adding Caddy.

**6. ElevenLabs key.** Only after Ivan fills the env file: `sudo bash -c 'set -a; . /etc/apprentice/env; curl -s -o /dev/null -w "%{http_code}\n" -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/user'`. Print the status only. 401 `missing_permissions` means a valid but scoped key; say so.

## Acceptance checks (run all, paste real results, never print `$T`)
`BASE=https://apprentice.exe.xyz`; `T=$(sudo grep ^API_TOKEN= /etc/apprentice/env | cut -d= -f2)`
```
curl -fsS $BASE/health | jq -e .ok
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/runner/v1/complete        # 401
curl -m 5 -s -o /dev/null -w '%{http_code}\n' https://apprentice.exe.xyz:8787/health   # not 200
sudo ss -ltnp | grep 8787                                                         # 127.0.0.1 only
curl -fsS -X POST $BASE/runner/v1/complete -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
 -d '{"prompt":"Customer_07 asks for order data as text in the email body. Return the customer id and the requested format.","schema":{"type":"object","properties":{"customer":{"type":"string"},"format":{"type":"string"}},"required":["customer","format"],"additionalProperties":false}}' | jq -e '.ok and .json.customer=="customer_07"'
convert -size 640x160 xc:white -pointsize 30 -fill black -draw "text 20,60 'To: customer_07'" -draw "text 20,110 'Order 1234, qty 5, 24.10.2026'" t.png
jq -n --arg d "$(base64 -w0 t.png)" '{images:[{media_type:"image/png",data:$d}],prompt:"Read the text.",schema:{type:"object",properties:{recipient:{type:"string"},order:{type:"string"}},required:["recipient","order"],additionalProperties:false}}' > v.json
curl -fsS -X POST $BASE/runner/v1/vision -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d @v.json | jq -e '.ok and (.json.recipient|test("customer_07")) and (.json.order|test("1234"))'
curl -si -X OPTIONS $BASE/health -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | grep -ci access-control-allow-origin   # 0
curl -si -X OPTIONS $BASE/health -H "Origin: <allowed origin>" -H 'Access-Control-Request-Method: POST' | head -1; ... | grep -i access-control-allow-origin   # 204, origin echoed
head -c 13000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/runner/v1/complete -H "Authorization: Bearer $T" --data-binary @-   # 413
```
Also: 5 parallel `/runner/v1/complete` calls return only 200 or 429, at least one 200; `sudo reboot`, then `/health` is ok with no manual step; `sudo -u apprentice /opt/apprentice/infra/deploy/deploy.sh` exits 0; `/health` shows the expected `mode`; after the calls above, `sudo journalctl -u apprentice-runner -u apprentice-api | grep -ci customer_07` and `sudo grep -rli customer_07 ~apprentice/.claude /var/lib/apprentice/runner-cwd` both give 0; p50 of 3 calls each for complete and vision.

## Report back (one message, no secrets)
1. Base URL and whether the public port works. 2. Deploy command and timer status. 3. Log commands. 4. Auth mode. 5. Every check result, including the vision and schema outputs and latencies. 6. Deviations, unverified items, and the patch path.