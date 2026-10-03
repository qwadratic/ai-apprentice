# CLAUDE.md — AI Apprentice (Hack-Nation 7, Challenge 01)

This file is the handoff for a fresh session. Read "Current plan" first, then `AGENTS.md` (rules shared with the Codex teammate), `backlog/docs/doc-1 - Parallel-work-rules.md`, the plans in `backlog/docs/plans/` (doc-4 is our stream) and `backlog task list --plain`. The sections after "Current plan" are background: the brief, the hackathon rules, the frozen Mac app and the earlier brainstorm.

**First action in a new session:** read "Current plan", run `backlog task list -s "In Progress" --plain` and `backlog task list -l stream-b -s "To Do" --plain`, then ask Ivan what to take.

## Current plan (3 Oct, ~23:00 Vienna)

Where older sections disagree, this section and the plans in `backlog/docs/plans/` win.

- **Product: a web app.** React frontend; the expert shares a window via `getDisplayMedia`; voice through the ElevenLabs Agents (ElevenAgents) web SDK; a backend API with SQLite and redacted media. Three modes: **Learn** (rare live questions at natural pauses), **Review** (gap questions, teach-back, confirm or correct the Work Map), **Teach** (the tutor on a new case, with a Preview → Send checkpoint in our demo workspace).
- **Demo scenario: customer_07.** The expert copies essential order data (delivery address and time) into the email body as text instead of attaching the template screenshot, because customer_07 asked to get it as text. The agent asks why, for whom, and whether an extra image is still fine. Process: order table → email → ticket. Tests on new data (doc-4 §6): T1 same customer, image only → ask for text before Send; T2 full text plus image → allow; T3 another customer → do not apply the personal rule; T4 unknown customer → ask, do not guess; T5 rule corrected in Review → apply the latest confirmed version; T6 reason unexplained or conflicting → say it is unknown. Expected results live in fixtures, separate from the map. All data is synthetic. The personal rule is never pre-written into a prompt: at least one fact is learned live from the expert.
- **Two streams, one repo.** Stream A: @kigulx, codes with Codex (reads `AGENTS.md`): capture, masks, vision, processed recording, replay, demo workspace, the repo skeleton and the root lockfile (plan doc-3). Stream B: @qwadratic (Ivan) with Claude Code: ElevenLabs voice loop, conversation policy (ASK_NOW / DEFER / SKIP, plus WARN in Teach), session and off-record, Work Map, Learn/Review/Teach UX and the app shell, tutor, scenarios, pitch (plan doc-4). Joint plan and call transcript: doc-2. The plans are Russian originals.
- **The only interface between streams: ScreenBridge v1** (TASK-1). Commands `start({sessionId, sessionEpochMs})`, `pause()`, `resume()`, `stop()`, `resolveEvidence(id)`; types `ScreenObservation`, `ScreenStatus`, `ScreenEvidence`, `ActionCheckpoint` with the reply `{checkpointId, status: clear|warn|unknown, message, evidenceIds}`; every timestamp counts from one `sessionEpochMs`.
- **Backend:** a separate exe.dev VM (TASK-4): SQLite and media on disk, HTTPS, deploy from `main`, an internal claude-runner on the Claude Agent SDK. It uses the team's Claude subscription token while developing; an Anthropic API key replaces it by env for the public demo. The ElevenLabs key stays on the server; the browser gets a signed URL.
- **Frontend deploy:** Vercel or GitHub Pages.
- **Mascot: Clipa.** Teal paperclip, dot eyes, no eyebrows; not "Clippy", no Microsoft artwork, no yellow paper. A web component is in progress on branch `feat/clipa`; it is the agent's face in stream B's app shell.
- **Mac app (`mac/`): frozen bonus.** The CI-built `.app` goes into a GitHub Release. Its accountant/programmer knowledge bases and the `sandbox/` pages belong to that bonus only.
- **Tasks:** Backlog.md. TASK-1 contract (shared), TASK-2 stream A parent, TASK-3 stream B parent, TASK-4 VM backend. Rules in doc-1.
- **Honesty rules from the plans:** the checkpoint works in our demo workspace; never claim to block clicks in arbitrary apps. Off-record stops both channels but does not recall data already sent. Screen masks do not clean speech. Mocks are replaced by real integrations before the demo and never presented as live.

## The situation

- **Team.** Ivan and one teammate, two people in total, at the Vienna hub (HOIV, Arsenalstraße 11). Talk to them in Russian, short and to the point. Repo, code and docs stay in English: the repo is public and judges read it.
- **Deadlines, Vienna time (CEST):**
  - Sun 4 Oct, 10:00 — local pitch at the hub. The live demo must work.
  - Sun 4 Oct, 15:00 — submission (09:00 ET). Late entries are not judged for prizes.
  - 8 Oct — finalists notified. 10 Oct, 18:00 — virtual finals.
- **Repo:** https://github.com/qwadratic/ai-apprentice (public, MIT). CI: `.github/workflows/macos-build.yml` on `macos-15`.

## Challenge 01 "The AI Apprentice" (ElevenLabs), in our words

The full brief is a PDF in the organisers' Google Drive; ask Ivan for it if you need the exact wording. Essentials:

**Story.** Sabine, 57, has run accounts payable for 24 years and retires in 18 months. Lena, 26, is new. Sabine silently:
- moves one invoice to another cost center;
- holds a second because that supplier double-bills every December;
- sends a third for a second approval because it comes from the Czech subsidiary.

The judgment is in her head. Recordings show *what*, not *why*. Guardrails are invisible until someone breaks them.

**Build all three modules:**

1. **Capture.** The expert does a real task and shares the screen. A frame every 1–2 s goes to a vision model and becomes events, e.g. "invoice 4471 opened, cost center 4711 → 0400". The voice agent stays quiet while the expert types, reads or talks. It asks at natural pauses: why this step, is there a limit, when would you stop and ask someone.
   *Required:* at least 3 questions during a real task, each at a natural pause and about something visible on screen, at least one about a guardrail.
2. **Map.** A spoken debrief after the task: questions about what is still unclear, then a teach-back that the expert confirms or corrects. The output is the **Work Map**: a clickable timeline. Every step shows the screen moment, the decision, the reason in the expert's words, and the guardrails.
   *Required:* the debrief asks at least 3 follow-ups not answered during the task and ends with a confirmed teach-back. Every step and guardrail links to a screen moment and the expert's words.
3. **Teach.** A voice tutor watches the new hire's screen on a case the expert never showed. It explains steps the way the expert did, asks the new hire to predict the next decision, and steps in **before** a guardrail is broken, replaying the expert's screen moment. At the end it shows what is mastered and what to practise.
   *Required:* a judge playing a new hire processes an unseen case. The tutor catches at least one wrong decision before it is saved and explains it with the expert's reasoning.

**The Apprentice Test — the demo must answer five questions:**
1. When to ask: pause detection, silence while typing, reading or talking.
2. What to ask: questions that reveal a reason or a guardrail, not what the screen already shows.
3. When it has understood: how the debrief decides it is done; the teach-back as proof.
4. Did the new hire learn: they handle a new case alone.
5. Trust: "off the record", and personal data on screen protected (hint: Microsoft Presidio).

**"What good looks like"** (the bar). A judge plays Sabine and processes three invoices while talking. At a pause the agent asks: "You moved that one to capex. What made you do that?" The judge answers: "Equipment over €5,000 is always capex." In the debrief it asks: "You held the December invoice. Is that for every supplier, and who decides when to release it?" The teach-back takes under a minute, and the judge corrects one detail. The Work Map has 7 steps, 3 judgment calls and 4 guardrails, each linked to its screen moment. Then a second judge, playing a new hire, opens a fresh €7,200 equipment invoice and reaches for the opex code. The tutor says: "Sabine would stop here. Why do you think?", replays her moment and lets them fix it.

**Strong vs weak:**
- Strong: asks at pauses about what is on screen; captures limits, exceptions and stop-and-ask moments; the debrief closes gaps and ends with a teach-back; the tutor teaches the new hire to decide; a pitch with a moonshot and a path to it.
- Weak: interrupting, generic questions, happy path only, a summary written afterwards, "a screen recording nobody will watch".

**Interface is free.** The brief names "a side panel, a floating voice companion, a replayable timeline or a coaching overlay. Experiment." Our native macOS cursor companion is in scope. The brief's own wiring suggestion is a web app with `getDisplayMedia`.

**Built with ElevenLabs:**
- ElevenAgents plays both roles, interviewer and tutor, with Expressive Mode. You choose the LLM behind it.
- Scribe v2 Realtime detects pauses.
- Client tools push screen events into the conversation.
- After the task, an LLM merges events, transcript and answers into Work Map JSON and lists the gaps.
- The Work Map goes into the tutor's knowledge base and Procedures. MCP tools let the tutor look up guardrails.

**Tips from the brief:**
- Start with voice and one screen; get screen events into the agent's context first.
- Ask less, later: 3–5 live questions per 10 minutes, the rest in the debrief.

**Stretch goals:**
- two experts on one task, and the apprentice asks each why they differ;
- the expert speaks German, the tutor teaches in English;
- export the Work Map as instructions an agent can follow.

**Moonshot.** One final slide. Candidates from the brief: a living company memory that asks only about what changed; an always-on apprentice; people first, then agents; the world's operations manual.

**Data hints in the brief:**
- your own workflow, which is the most honest data;
- O*NET (18,838 tasks, CC BY 4.0);
- WebArena — checked: about 180 GB self-hosted, not usable tonight;
- Presidio.

**The brief's own good-workflow test:** 5–10 minutes on screen, at least one judgment call that is written down nowhere, real guardrails.

## Hack-Nation rules that apply to every track

**Submit five things:**
1. demo video (problem, solution, UI);
2. tech video (how it is built, how complex);
3. team video (who you are, what you study, what drives you);
4. **public GitHub**;
5. **deployed demo** — "We don't want localhost. We want to click."

Submit on **app.hack-nation.ai** (login is the Luma email) **and** on the backup Google Form (link in Discord). Team size is up to 4; members are added at submission.

**Judging.** 170+ human judges. Three criteria:
- technical complexity — "if we just see a UI, that's not nice";
- communication — the videos;
- innovation and creativity.

**Prizes:**
- ElevenLabs track: ElevenLabs credits and a small cash prize.
- Overall winner: Venture Lab fast track and $2,000 in Anthropic credits.
- Side awards: creativity ($500 Anthropic credits); Go Viral — a LinkedIn post tagging Hack-Nation with the most reactions at the deadline. Never publish anything without Ivan's explicit yes.

**Freebies, all via Discord:**
- ElevenLabs Creator tier free for a month. The code path was not found yet; ask in Discord. Creator includes 275 ElevenAgents minutes, then $0.08/min.
- Claude $25 codes, 600 total, first come.
- Lovable credits.
- Bright Data $300.

## What is in this repo now

**`mac/` — native macOS app "Apprentice" (frozen bonus since 3 Oct night).** Swift Package, macOS 14+, 26 files, about 2,600 lines. **CI build is green on `macos-15`** (first run: https://github.com/qwadratic/ai-apprentice/actions/runs/37150081512, artifact `Apprentice-macos`). It has never been *run* on a Mac yet. What it does:
- Menu bar item only, no Dock icon (`LSUIElement`). Menu: show/hide buddy, Off the record, scenario, Learn/Teach mode, open KB, open session log.
- Click-through transparent overlay on every screen. A buddy follows the cursor with spring smoothing, fades in only to speak, then fades out.
- ScreenCaptureKit snapshot every ~1.5 s, a difference hash for "meaningful change", and on-device Vision OCR. No network on the default path.
- Idle states from `CGEventSource`: typing, working, pause (2.5–8 s), idle (>60 s), away (>5 min).
- Intervention policy: never while typing, talking or speaking; only at a pause after a meaningful change matched a KB rule; at most 4 per 10 minutes; no repeats.
- Learn mode speaks the rule's `question`. Teach mode speaks the rule's `warning` when the cursor nears an `action_words` button (Merge, Post, Refund…).
- Push-to-talk on Control+Option with on-device `SFSpeechRecognizer`. Answers are appended to `kb/<id>/learned.jsonl`. Session events go to JSONL — raw material for the Work Map.
- Voice: `SystemVoice` (AVSpeechSynthesizer) by default. `ElevenLabsVoice` (REST TTS, `eleven_v4_turbo`) activates when an API key and voice id are configured.
- Optional `ClaudeBrain` (screenshot + profile + matched rule → one question), `ANTHROPIC_API_KEY`. Without any keys, everything still works through `RuleBrain`.
- Configuration lives in `~/Library/Application Support/Apprentice/config.json`, or env vars (see `mac/README.md`).
- Build on a Mac: `cd mac && swift build && scripts/build-app.sh && open build/Apprentice.app`.
- Permissions to grant: Screen Recording, Microphone, Speech Recognition, Input Monitoring/Accessibility. The ad-hoc signature changes on every build, so reset with `tccutil reset ScreenCapture com.hacknation.apprentice`.

**`mac/Resources/kb/` — three roles.** Each has `profile.md`, `rules.json` (6–9 rules, ≥2 guardrails) and `demo.md` (3-minute script: three expert cases, then one novice case):
- `programmer` — a maintainer who merges a PR with a red check (known-flaky e2e) and rejects an all-green PR (adds a dependency with `postinstall`). Novice case: a green PR with `test.skip(` and a loosened assertion, stopped before Merge.
- `accountant` — the brief's running example (4471: 4711 → 0400, the December double-biller held, the Czech subsidiary sent for approval). Novice case: €7,200 equipment on 4711. Supplier names, other invoice numbers and amounts are invented and marked as such.
- `support` — refunds and exceptions. Example policy values: 30 days, 250 EUR. **Ivan dropped support in the ChatGPT brainstorm (see below) — probably replace it.**

**`sandbox/` — static demo pages** the buddy reads with OCR: `programmer.html`, `accountant.html`, `support.html`. 20 px text, case switcher (keys 1–9 or `#id`). `python3 sandbox/check_cues.py` checks that every rule cue really appears on its page and that the expected rules fire per case. It currently passes.

**Not built yet:**
- Map: debrief, teach-back, Work Map UI.
- Teach extras: predict-the-next-decision, replay of the expert's moment, mastery summary.
- A real ElevenAgents conversation (today it is TTS only).
- Presidio-grade redaction (today: regex masking of emails, IBANs, cards, phones).
- The deployed clickable demo, the videos, the moonshot slide.

## Decisions already taken, and why

Background from before the plans. Where it conflicts with "Current plan", the plan wins.

**Why Challenge 01.** All five challenges were checked live with downloads and test runs:
- 03 Databricks (Omnigent works, gene–disease prediction experiment) and 05 Rare Disease Atlas: dropped — the team cannot judge its own results on genes and diseases (Ivan's reasoning, paraphrased).
- 02 RealPage: the starter pack is truncated (`participant-final-no-hour16`: no `score.py`, no dev key, no T6), and key law texts are missing from the corpus.
- 04 World Bank Small AI: entry is limited to ages 18–35 (not confirmed for the team), and the brief's "would SMS or a search do the same?" test is hard to pass; the team moved on.
- 01: Ivan picked it. Two things carried it: the PR-merge story (the reason behind a decision is never visible on screen), and a macOS companion in the style of Clicky.

**Why the PR-merge story fits.** Vision sees red or green, but the decision does not follow the colour.
- Red but merge: flaky test; failure unrelated to the diff; a fork without secrets; a non-required check; an urgent security hotfix; an intentional snapshot change; a CLA bot on a typo fix.
- Green but reject: tests deleted, skipped or loosened; a new dependency or `postinstall`; workflow or `pull_request_target` edits; wrong product direction; hidden performance or API breaks; an unreadable or AI-generated mega-PR; a release freeze.
- Real background stories, accurate: xz-utils 2024 (CI green, backdoor in test files and tarballs); event-stream 2018 (malicious `flatmap-stream` dependency); Hacktoberfest 2020 spam leading to opt-in. The novice's natural mistake is "green means merge", which gives the strongest tutor stop.

**Clicky as reference.** https://github.com/farzaa/clicky (MIT, Swift, about 7.7k stars). Push-to-talk (Control+Option) streams to AssemblyAI, the screenshot and transcript go to Claude, the answer is spoken by ElevenLabs, and a blue cursor flies to UI elements via tags in Claude's answer. Our app reuses the patterns, credit in `mac/THIRD_PARTY_NOTICES.md`. The pointing-cursor trick is not implemented yet and would make a strong Teach feature.

**Voice.** System voice now ("make it work first"), ElevenLabs next.

**Character idea from Ivan.** A paperclip helper that reminds people of the old Office Assistant, without infringing:
- not the name "Clippy" or "Clippit";
- not Microsoft's artwork (silver gem clip with googly eyes and eyebrows on yellow paper);
- not the "It looks like you're writing a letter" line as branding.

Own clip shape and colour, own face, a bright own name. Ivan floated "Дарья" only as an example of giving it a name. The repo name stays `ai-apprentice`.

## The team's ChatGPT brainstorm (3 Oct, ~19:50–21:40 Vienna), condensed

Ivan shared the chat "Брейншторм идей для хакатона". Where it ended up:

**Direction.** Overview of the 5 tracks → the team likes ElevenLabs → support dropped (the team does not want to show anything from work) → "something complex enough that the product doesn't look useless": the frame is an expert who has done the job for 45 years and is leaving → any domain is fine as long as the complexity is real → no live expert available, so the night is for inventing a fictional company, its rules and cases, and one teammate plays the expert (present it honestly as a simulation) → "the tests are debatable" → a short side trip to World Bank agriculture → back to ElevenLabs with a fresh agent that had no chat memory.

**Explicit preferences:**
- No support domain, nothing from the team's jobs.
- Not trivial: no photo culling, product cards or CSV cleanup.
- Concrete test scenes, not just domain names.
- Objective tests, not taste: "the expert preferred another connection" does not count.

**Test design — the most valuable part:**
- The error must be **provable by outcome**: lost records, a wrong sum, a broken or incomplete file. The right answer exists independently of the expert's and the model's opinion.
- Prove what the apprentice learned **from the expert**. Run the same new case without the expert's memory and with it, with the same data access. A plain model cannot guess internal semantics.
- Always include an **"allow" counter-test.** A tutor that says stop to every risk proves nothing.
- Do not pre-write the agent's lines, the Work Map or the warnings. The system must derive them. Keep the gold answers separate, for evaluation only.
  - Tension with this repo: `rules.json` currently holds seeded questions and warnings. They are reliable for a live pitch, but they are pre-written. A sensible hybrid: rules keep cues and gold answers; the question and the warning are generated from screen events plus the expert's answers; seed text is only a fallback.
- **Strongest live test:** the expert states a new rule during the demo that exists nowhere in code; the novice opens another case; the tutor applies exactly that rule.
- Each domain should allow about five cases where a novice makes a reasonable but wrong choice. Core set: transfer, exception, unknown (ask for data), and a combination where each condition is fine but together they break.

**Concrete patterns from the chat** (numbers are the chat's own examples):
- **Legacy data migration.** Exporting B/42 +140 and C/42 −60 by customer number merges two different customers. Correct: two customers, balances −140 and +60. Counter-test: two B/42 rows with different contracts are one customer with two contracts, so the tutor must not forbid merging altogether.
- **Payout reconciliation.** 200 − 20 − 6 − 10 = 164, and the novice wants to call the 10 a fee. Counter-test: fee 16, reserve 0, still 164, and here "fee" is right. Third case: the sums match, but two identical batches are matched to the bank lines the wrong way round.
- **VFX handoff.** Shot range 100–149 plus 12 handles means 88–161 is needed, but the source has 90–160: stop, it is 2 frames short at the head and 1 at the tail; request the full source. Counter-test: an approved v3 covers 80–170 while v4 is unapproved, so taking v3 is right — allow.
- **Inherited Excel model.** 12 h × 3 people × 50 gives 600 instead of 1,800: fix the formula, not the total. Check by changing an input: at 14 h the right answer is 2,100. Counter-test: on another tab 12 is already person-hours, so 600 is right.
- **Release engineering.** All tests are green, but the new version writes data the old one cannot read: demand a rollback plan. Counter-test: a known-flaky test failed after an alternative check passed, so do not block. This is the same family as our `programmer` scenario.
- **Prepress / packaging** — the fresh agent's favourite.
  - Story: a designer delivers a nice box layout; the prepress expert decides whether it can go to print.
  - Expert case: fixes an unintended white overprint on the logo, but keeps a bright contour line because it marks the die-cut. Questions to the expert: why fix one and keep the other, how do you know the contour is for production, what can you fix alone and what needs sign-off.
  - Novice case: a spot-varnish layer in a bright colour, and the novice wants to convert all spot colours to CMYK. Stop: that layer is a separate print operation. Counter-test: an accidental decorative spot colour may be converted.
  - Weak spots: automated preflight already catches the simple errors, so the demo must live on ambiguous choices; and nobody on the team is confirmed to know prepress.

**Left open in the chat:**
- the final domain — prepress, migration, payout reconciliation, VFX, museum georeferencing were the last candidates;
- who on the team is a real expert in anything;
- what demo materials prepress would need;
- how to show the with/without-expert baseline;
- trust and PII (Apprentice Test question 5);
- the moonshot slide.

The chat's tool and data claims were not verified, except where this file says checked. The World Bank side idea (an offline bean or coffee leaf classifier) was dropped with track 04.


## Decisions log (Ivan's answers, 3 Oct night)

1. **Credentials.** ElevenLabs key: add it to the cloud environment as `ELEVENLABS_API_KEY` (only new sessions see it) and to the VM's env file. Voice: any good one; Rachel `21m00Tcm4TlvDq8ikWAM` was suggested, the id is not verified yet. No Anthropic API key for now: Claude runs through the team's subscription on a VM; switch to an API key (a $25 code) if the public demo needs it. Never in git.
2. **Where work happens.** Cloud sessions plus CI; Ivan downloads artifacts and tests on a Mac. Two Macs, both on current macOS; who demos is not decided. Ivan's VMs are reached through `claude remote-control` sessions, not SSH (port 22 is closed from the cloud container).
3. **Native vs web.** The web app is the product. The Mac app is a frozen bonus distributed through GitHub Releases. Web on Vercel or Pages, API on an exe.dev VM.
4. **ElevenAgents.** As in plan B: screen context goes in as contextual updates, our own policy decides when the agent asks, one conversation coordinator.
5. **Domain.** The customer_07 email case. The app stays domain-agnostic: a fixed schema with namespaced extensions, scenarios as data.
6. **Character.** Clipa (see Current plan).
7. **Macs.** Settled.
8. **Scope cut order.** Open, Ivan decides later. Plan B's own fallback: cut visuals and map complexity first; keep one working Learn → Review → Teach and the whole voice loop.
9. **Later, not tonight.** Demo videos could be hosted in a separate video library (transcription off) on the streaming platform used by Ivan's other project. Its existing library must not be touched; credentials stay with Ivan.

## How to work here

- Before changing rules or sandbox pages, run `python3 sandbox/check_cues.py`. It must stay at "ALL PASSED".
- After any change under `mac/`, push and watch CI: `gh run watch -R qwadratic/ai-apprentice`. Green CI is the only proof that it compiles; a run on Ivan's Mac is the only proof that it works.
- Keep the public repo professional: no secrets, no personal data, no internal chatter in commits.
- Ask before anything irreversible or public: publishing posts, messaging people, submitting the entry.
- Subagents that do the work (research, drafting, coding) run on Sonnet (`model: sonnet`). Critics, verifiers and judges run on Opus (`model: opus`). A single workflow run must fit in 30 minutes; estimate its length from the token rate of earlier runs.
- Tasks live in Backlog.md (`backlog/`, install with `npm i -g backlog.md`). Before creating, claiming or finishing a task, follow `backlog/docs/doc-1 - Parallel-work-rules.md`: children only under your own stream's parent, new top-level tasks only on `main` and pushed at once, claim on `main` before branching, one task per branch, Done only when merged.

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.53.0 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
