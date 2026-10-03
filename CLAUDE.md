# CLAUDE.md — AI Apprentice (Hack-Nation 7, Challenge 01)

This file is the full handoff for a fresh session. Another Claude session bootstrapped this repo on the evening of Saturday 3 October 2026. That session and the team's own ChatGPT brainstorm are both condensed here. Read this file, then `mac/README.md`, then `mac/Resources/kb/*/demo.md`.

**First action in a new session:** go through "Open decisions" at the end with Ivan and get answers before writing code.

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

**`mac/` — native macOS app "Apprentice".** Swift Package, macOS 14+, 26 files, about 2,600 lines. **CI build is green on `macos-15`** (first run: https://github.com/qwadratic/ai-apprentice/actions/runs/37150081512, artifact `Apprentice-macos`). It has never been *run* on a Mac yet. What it does:
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


## Open decisions — ask Ivan first

1. **Credentials.** Keys go only in the Mac's `config.json` or env, never in git.
   - ElevenLabs API key, and later an ElevenAgents agent id;
   - a voice id;
   - an Anthropic key (a $25 Claude code works) for vision, Work Map and debrief.
2. **Where work happens.** A cloud session can edit code and run the `macos-15` CI, but cannot run a macOS UI, grant permissions or hear audio. Every real test needs Ivan's Mac. Options: Claude Code on Ivan's Mac for UI iteration and the cloud session for web and LLM parts, or the cloud only plus CI artifacts that Ivan downloads and tests.
3. **Native Mac vs web, and the "deployed demo" rule.** Hack-Nation wants a clickable link.
   - Recommended: keep the Mac app as the product, and deploy a web Work Map viewer plus the sandbox pages (GitHub Pages or Vercel). Offer the `.app` as a GitHub Release, and show the full loop in the demo video.
   - Alternatives: rebuild Capture as a web app (`getDisplayMedia`, as the brief sketches), or both.
4. **ElevenAgents.** The brief expects ElevenAgents to play interviewer and tutor; today we only use TTS. Options: native WebSocket to ElevenAgents with client tools carrying screen events; an embedded WebView running `@elevenlabs/client` (`sendContextualUpdate` for events); or keep the native rule-driven questions and use ElevenAgents only for the debrief and teach-back conversation. The last is the lowest risk for a live pitch.
5. **Main demo domain.** Pick one; `support` is out.
   - `accountant` — the safest: it is literally the judges' "what good looks like".
   - `programmer` / release engineering — developer judges relate to it, the team can judge the quality itself, and errors are provable by outcome.
   - From the brainstorm: payout reconciliation and the Excel model have arithmetic proof; prepress is visual but needs domain knowledge.
   - Whichever is chosen, design the cases with the brainstorm's test rules: provable outcome, an allow counter-test, the with/without-expert baseline, a rule stated live.
   - Who plays the expert, who plays the novice?
6. **Character.** Name and look of the paperclip (see above). Replace the current generic buddy in `BuddyView.swift`.
7. **Ivan's Mac.** macOS version, Apple Silicon or Intel, mic. Has the app been run, and are the permissions granted?
8. **Scope cut if time burns.** Capture (3 questions, 1 guardrail) → Work Map from one session (one LLM call plus a validator: every step linked to a moment and a quote) → debrief of 3 questions with teach-back → tutor catches one mistake. Two experts, languages and MCP are cut first.

## How to work here

- Before changing rules or sandbox pages, run `python3 sandbox/check_cues.py`. It must stay at "ALL PASSED".
- After any change under `mac/`, push and watch CI: `gh run watch -R qwadratic/ai-apprentice`. Green CI is the only proof that it compiles; a run on Ivan's Mac is the only proof that it works.
- Keep the public repo professional: no secrets, no personal data, no internal chatter in commits.
- Ask before anything irreversible or public: publishing posts, messaging people, submitting the entry.
- Subagents run on Sonnet (`model: sonnet`), not Opus. A single workflow run must fit in 30 minutes; estimate its length from the token rate of earlier runs.
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
