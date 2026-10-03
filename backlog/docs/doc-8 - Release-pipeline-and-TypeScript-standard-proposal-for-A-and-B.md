---
id: doc-8
title: Release pipeline and TypeScript standard - proposal for A and B
type: specification
created_date: '2026-10-03 23:15'
---


# Release pipeline and TypeScript standard

Proposal from stream B's coordinator for both streams. Goal: any merged PR, from a person or from any agent, reaches the deployed demo without anyone logging into the VM, and both streams write the same language with the same rules.

## 1. What a deployed slice consists of

| Part | Where it runs | Built from | Owner |
| --- | --- | --- | --- |
| Web app | GitHub Pages, https://qwadratic.github.io/ai-apprentice/ | `apps/web` (A's Vite + React + TypeScript skeleton) with B's `features/agent` (app shell, Learn/Review/Teach, Clipa) and A's `features/screen` and `features/demo-workspace`. Until the skeleton lands, the static agent lab is the site | A: skeleton and build; B: shell |
| API | exe.dev VM, one Node 22 process on port 8000 behind https://apprentice.exe.xyz | `apps/api`: A's server entry mounts A's `apps/api/screen` (frames, `GET /screen/sessions/{id}/updates`, evidence) and B's `apps/api/agent` (signed URL, session logs, later Work Map and checkpoint replies). Until then `infra/placeholder-api` serves the B routes | A: server entry and screen routes; B: agent routes |
| Claude runner | same VM, 127.0.0.1:8787 only | `infra/claude-runner` | TASK-4 owner |
| Storage | same VM, `/var/lib/apprentice/{db,media,sessions}` | SQLite plus files | TASK-4 owner; each stream owns its tables |
| Voice agents | ElevenLabs | config as code in `apps/api/agent/elevenlabs`, applied by `provision` | B; applying it to the live agent needs Ivan's approval each time |
| Secrets | `/etc/apprentice/env` on the VM (0600) and the environments' settings | never in git, CI logs or Hive | Ivan |

## 2. Pipeline

1. **PR** from a task branch. CI runs every check: backlog IDs, type-check and tests of every package, the web build. Stream owners merge their own PRs when CI is green and a reviewer passed (decision-1 for B); a PR touching the contract or the other stream's paths needs both owners.
2. **Release workflow on main** (`.github/workflows/release.yml`): on every push to `main` it runs the full check suite again on the merged result. If green, it fast-forwards the branch `deploy` to that SHA and builds and publishes the web app to Pages. If red, nothing moves.
3. **VM pull deploy.** The existing `apprentice-deploy.timer` runs every minute with `DEPLOY_REF=deploy`: fetch, install by lockfile, build, restart only what changed, health check, roll back on failure, skip a SHA that failed before. `/health` reports the deployed SHA. No SSH keys or VM credentials live in GitHub; the VM only reads the public repo.
4. **Infra changes are the one manual step.** Changes under `infra/systemd`, `infra/install.sh` or sudoers need root, so deploy does not apply them; it logs "infra changed, run sudo infra/install.sh" and a person (Ivan) runs it. Everything else, including the runner and the API code, deploys automatically.
5. **Freeze and rollback.** A repository variable `DEPLOY_FREEZE=1` stops step 2 from moving `deploy` (set it before the 10:00 pitch). Rollback = a manual run of the release workflow with a SHA input that moves `deploy` back.
6. **Status.** The release workflow and the VM deploy post one line to the project's Hive channel (deployed SHA or failure), with no secrets.

## 3. TypeScript standard (both streams)

- No `.js`, `.mjs` or `.cjs` sources anywhere in our code; built output is not committed.
- TypeScript 7.0.x, one root `tsconfig.base.json` (A owns root files) that every package extends: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, ESM, `skipLibCheck`; Node packages use explicit `.ts` imports with `allowImportingTsExtensions` and `noEmit` and run with Node 22's type stripping; the web app is built by Vite.
- No `any`: `unknown` plus validators at JSON, network and storage boundaries; no non-null assertions without a comment.
- One package manager and one root lockfile from A's skeleton; package-local lockfiles (B's packages, infra) are folded in when the workspace lands.
- CI runs `tsc --noEmit` for every package. Tests run with `node --test` on `.ts` files.
- Today's remaining JavaScript: A's `apps/api/screen/*.mjs`, `packages/screen/vision/*.mjs` and capture tests (A converts); B's ElevenLabs scripts and lab page (in progress, TASK-3.24); infra is already TypeScript on PR #5.

## 4. What each side does next

- A: confirm or change this document; root `tsconfig.base.json` and workspace in the foundation PR; convert A's `.mjs`; server entry in `apps/api` that mounts both routers; the polling route.
- B: `release.yml` and the Pages build (TASK-6.1); move the B routes from `infra/placeholder-api` into `apps/api/agent` once A's server entry exists.
- TASK-4 owner: switch the VM to `DEPLOY_REF=deploy`, enable the timer, run `sudo infra/install.sh` once after PR #5 merges. After that no agent needs to stay on the VM.
