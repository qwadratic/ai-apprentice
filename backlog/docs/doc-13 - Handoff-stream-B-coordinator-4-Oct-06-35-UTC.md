---
id: doc-13
title: 'Handoff - stream B coordinator, 4 Oct 06:35 UTC'
type: other
created_date: '2026-10-04 06:08'
updated_date: '2026-10-04 06:33'
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
- **TASK-3.50, Clipa for macOS.** The builder finished: branch `task-3.50-macos-clipa`, head `ccf6ccc`, macos-build CI green, artifact `Clipa-macos`. Not run on a real Mac yet; no PR yet. Details in the prompt below.
- **TASK-3.51, live feed and visuals.** Merged as PR #54 and deployed.

## Next, in order
1. Finish TASK-3.53 and deploy it.
2. TASK-3.54: give Ivan 2–3 demo options with exact lines, two languages and two processes (an email and a table). Rehearse one.
3. TASK-3.55: demo mode (a demo marker, a short demo, off-script nudges, a language-switch hint).
4. TASK-3.56: design pass (dark theme, desktop-first, fewer buttons, no explanatory text). TASK-3.51 is merged; build on it. Record once with the video toolkit (TASK-3.34; branch `task-3.34-video-toolkit` is ready for a PR).
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

## Prompt for the next coordinator (06:45 UTC)

Paste this as the first message of the new session.

You are the new stream B coordinator for **Clipa** (Hack-Nation 7, Challenge 01) in the repo `qwadratic/clipa` (renamed from `ai-apprentice`). Talk to Ivan in Russian, short. Keep the repo, code and docs in English. Pitch at 08:00 UTC, submission at 13:00 UTC on 4 Oct.

### Read first, in this order
1. `CLAUDE.md` (rules, including: no agent browser runs; ship on green `npm run check` + CI; Opus for critical-path builders; at most 2 builder agents at once; ask Ivan before live config changes; never print keys, tokens or signed URLs).
2. Backlog **doc-13** (handoff 06:35 UTC), **doc-12** (Clipa Conductor v1.1), **doc-10** (demo journey).
3. Backlog **doc-14**, if it exists. It holds the result of the requirements analysis described under "Workflow" below.
4. `backlog task list -l stream-b --plain`.

### Live now
- Web: https://qwadratic.github.io/clipa/. API: https://apprentice.exe.xyz. Every merge to main deploys both. The API restarts on deploy, and confirmed maps live only in memory, so don't deploy between Reflect and Pass it on during a demo.
- Merged today:
  - the server Clipa Conductor, PR #49;
  - the web conductor client, PR #52 and #53;
  - the journey rail Show / Reflect / Pass it on, PR #51;
  - the live feed, cleaner views and dark theme, PR #54;
  - recording and replay with quota, PR #48;
  - the Clipa wire logo, PR #46 and #50.
- ElevenLabs agents (interviewer and tutor) are on demo-pace prompts: the app asks through `[ASK]`, and Clipa replies in one sentence.

### In progress, continue from the branches
- **TASK-3.50, Clipa for macOS.** The Opus builder finished. Branch `task-3.50-macos-clipa`, head `ccf6ccc`, CI green (macos-build run 37182996880, artifact `Clipa-macos`). No PR yet.
  - Built: menu bar plus overlay only, no windows; `SCStream` of the main display at 2 fps, changed frames only, one upload in flight, about 1.6 s pacing; conductor client (events in, cues out, `open_web` hands Reflect to the browser); ElevenLabs Conversational AI over a WebSocket with voice processing; the old KB/OCR/push-to-talk path removed; `Clipa --smoke` runs on manual CI runs only.
  - Proved on the CI Mac against the live API: session, cues, one frame accepted in 290–480 ms, voice live, `open_web` on End.
  - Not tested on a real Mac: capture permissions, real microphone and speakers, overlay motion, typing detection, the full hand-over to the browser. No masks on macOS frames: demo data must be synthetic.
  - Next: Ivan runs the artifact on his Mac (`xattr -dr com.apple.quarantine Clipa.app`, grant Screen Recording, Microphone, Input Monitoring, reopen). If it works, open the PR (only `mac/**` and `.github/workflows/macos-build.yml` changed) and merge.
- **TASK-3.53, demo pace and the process library.** WIP branch `task-3.53-demo-pace-processes` at `5e73786`. Typecheck passes. Still to do: update the conductor and LLM tests (map fixtures need `processes` and `processId`), update the pinned prompt hashes for `map-synthesis.ts` and the new `process-match.ts`, and add a `process_match` route test. Then open the PR and merge.
- **TASK-3.52, generic vision (`screen_activity`).** Not started. It blocks real-site demos: today vision knows only order / email / ticket, so Sheets and Maps produce no observations.

### Workflow
The previous session ran a multi-agent workflow called `clipa-requirements-and-plan`.
- **Inputs:** every ElevenLabs session, especially the moments where the team interrupted the demo to give Clipa feedback, plus Ivan's chat messages.
- **Outputs:**
  - a spec, "What we want from Clipa";
  - backlog updates and new tasks;
  - a parallel plan in lanes with file ownership, at most 2 builders at once.

If doc-14 exists, follow it and run its lanes. If it does not, re-run that analysis yourself with the Workflow tool:
1. Fetch the conversations for both ElevenLabs agents with `ELEVENLABS_API_KEY` and read them locally only.
2. Extract requirements, then synthesise, critique and revise.
3. Put the result in the backlog.

Ivan's latest direction, in short:
- the demo fits 2–3 minutes and covers two business processes (an email and a table) in two languages, with a language-switch hint;
- a demo mode where Clipa knows it is a demo, keeps it short, steers back an off-script user and hints what to do next;
- a design pass: dark, graphical, desktop-first, fewer buttons, no explanations;
- Clipa explains Off the record;
- Clipa recognises the app and the task, and follows the learned process's strategy;
- the brain is reusable (an MCP server or SDK);
- macOS: no windows, only Clipa, real-time screen streaming, a link to the web session for Reflect.

The tasks are TASK-3.53 to TASK-3.58.

### Hive (the team's agent relay; public and permanent)
- **Channels:**
  - lobby `833a14bc-4449-401d-b835-2b6689295390`;
  - engineering `9b03b1be-room` (the integration thread root starts `55345cd6`);
  - design `f52c0f42-room`.
- **Who is there:**
  - stream A, Kirill's Codex agent, key prefix `9e7447fd`;
  - the **devops agent on the VM**, key prefix `eddff6e1`. It has the full deploy and VM context and posts every deploy result. Ask it for VM facts.
- **Pending: DEMO-REAL-3 from stream A.** Kirill proposes three real-browser demo cases:
  1. Gmail: Net 14 to Net 30 for one customer;
  2. Google Sheets: spreading a prepaid annual software cost across quarters;
  3. Google Maps: rejecting the top-rated venue because the meeting needs a private room.

  He asked for a status of each step. The previous coordinator answered at 06:25 UTC; the facts are in that reply. Follow up with him. Point out that Sheets and Maps need TASK-3.52 first, and agree with him and Ivan on what is shown at 08:00. The demo workspace (order table and email) is the safe fallback.
- **Access.** You need your own Hive identity: ask Ivan. Never post secrets, transcripts, signed URLs or personal data there. Never push to stream A's branches.

### First steps
1. Read the documents above.
2. Finish TASK-3.53.
3. Ask Ivan to run the `Clipa-macos` artifact; PR TASK-3.50 when it works.
4. Agree with Ivan which demo is shown at 08:00 (TASK-3.54).
5. Reply in Hive on DEMO-REAL-3.

Report to Ivan in Russian, 3–6 short lines.
