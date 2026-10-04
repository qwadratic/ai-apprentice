---
id: doc-13
title: 'Handoff - stream B coordinator, 4 Oct 06:35 UTC'
type: other
created_date: '2026-10-04 06:08'
updated_date: '2026-10-04 06:08'
---
# Handoff: stream B coordinator, 4 Oct 06:35 UTC

Written for the next agent. Talk to Ivan in Russian, short. Keep the repo, code and docs in English. Pitch: 08:00 UTC (10:00 Vienna). Submission: 13:00 UTC (15:00 Vienna).

## What is live
- **Web:** https://qwadratic.github.io/clipa/. The repo was renamed to `qwadratic/clipa`, and the Pages base path follows the repo name.
- **API:** https://apprentice.exe.xyz (exe.dev VM). Every push to main deploys Pages and the VM through `release.yml` and its guards.
- **Product shape:**
  - **Clipa Conductor** (`apps/api/agent/conductor/`, backlog doc-12 v1.1). One server loop decides what Clipa says and does: events come in, Server-Sent Events cues go out. It serves the web and the macOS faces, and links them with join codes.
  - **The web shell is a conductor client** (`apps/web/features/agent/shell/conductor/`). Navigation is the journey rail Show / Reflect / Pass it on (modes learn / review / teach). Clipa is one persistent layer that rests on the rail.
  - **Server-side LLM tasks** (`apps/api/agent/llm-tasks.ts`): generic_question, map_synthesis, map_edit, guardrail_check, reply_classification, answer_extraction, entity_resolution. Latency-bound tasks run on `AGENT_FAST_MODEL`.
  - **Screen path.** The screen hub hands every vision observation to the session's conductor on the server. Recording and replay are merged (#48), with a per-session quota.
  - **ElevenLabs.** An interviewer agent and a tutor agent (their ids are in `/etc/apprentice/env`). Live prompts since 06:15 UTC: the app asks through `[ASK]`, Clipa replies in one sentence, and the greetings are short.
- **Vision limit.** Vision still knows only order / email / ticket surfaces. `screen_activity` for any app is TASK-3.52 and has not started.

## In flight
- **TASK-3.53, demo pace and process library.** Branch `task-3.53-demo-pace-processes`, WIP head `5e73786`.
  - Typecheck passes.
  - To do: update the conductor and LLM tests (map fixtures need `processes` and `processId`), update the pinned prompt hashes (`map-synthesis.ts`, new `process-match.ts`) and add a `process_match` route test. Then open the PR, merge and deploy.
- **TASK-3.50, Clipa for macOS.** An Opus builder was running on branch `task-3.50-macos-clipa`; the macOS-build workflow (`.github/workflows/macos-build.yml`) builds it in CI. If this session ends, the builder may stop: check the branch and its CI run.
- **TASK-3.51, live feed and visuals.** An Opus builder was running on branch `task-3.51-live-feed`. Same caveat.

## Next, in order
1. Finish TASK-3.53 and deploy it.
2. TASK-3.54: give Ivan 2–3 demo options with exact lines, two languages and two processes (an email and a table). Rehearse one.
3. TASK-3.55: demo mode (a demo marker, a short demo, off-script nudges, a language-switch hint).
4. TASK-3.56: design pass (dark theme, desktop-first, fewer buttons, no explanatory text). Merge TASK-3.51 first. Record once with the video toolkit (TASK-3.34; branch `task-3.34-video-toolkit` is ready for a PR).
5. TASK-3.52: generic vision `screen_activity`. The macOS app and any non-workspace app need it.
6. TASK-3.50: Ivan tests the CI build on his Mac.
7. Then TASK-3.57 (Clipa explains Off the record), TASK-3.58 (brain as an MCP server or SDK), TASK-3.48 / 3.49 / 3.39 / 3.7 / 3.43 / 3.40.
8. Submission: TASK-3.16, 3.18, 3.19, 3.20.

## Rules that hold (see CLAUDE.md)
- **Builders and checks:**
  - No agent browser runs; the team checks by hand.
  - Ship a fixed change as soon as `npm run check` and CI are green: PR, then a merge pinned to the head sha, then release.
  - Critical-path builders run on Opus. At most 2 agents at once.
- **Security:**
  - Ask Ivan before live production config changes and before anything public or irreversible.
  - Never print keys, tokens or signed URLs.
  - Hive is public and permanent.
  - Read transcripts only locally.
- **Stream A:**
  - Never push to stream A's branches. Stream A (Kirill, Codex) has been silent since about 03:44 UTC. The `screen_activity` and conductor contracts are posted in the Hive integration thread.
  - `app://apprentice-macos` is allowed in `ALLOWED_ORIGINS`.
- **Ops:**
  - VM operations go through the devops remote-control session on the VM; ask Ivan for it.
  - Tailscale access for a trusted engineer: the VM side is done. Ivan's part is in the Tailscale admin console: a tag, an SSH rule and the machine share.
