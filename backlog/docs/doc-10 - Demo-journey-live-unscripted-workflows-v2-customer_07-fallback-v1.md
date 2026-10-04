---
id: doc-10
title: 'Demo journey - live unscripted workflows (v2), customer_07 fallback (v1)'
type: specification
created_date: '2026-10-04 02:44'
updated_date: '2026-10-04 04:11'
---

# Demo journey: one shared expectation for A and B

## v2 (current, Ivan, 4 Oct 04:05–04:15 UTC): live, unscripted workflows

The live demo runs **outside our demo workspace**. Each run, the team makes up a new workflow on the spot, for example writing real emails to each other in a mail client and explaining why they do things a certain way. The expert shares the **entire screen**. Nobody, including us, knows the workflow in advance. The product must therefore work on any screen. customer_07 and the demo workspace (v1 below) become the fallback.

| # | Step | What happens | Owner |
| --- | --- | --- | --- |
| 1 | Open and share | Clipa greets the user and leads them to share the entire screen. A live mini-preview shows what is captured. | B (shell, Clipa), A (capture) |
| 2 | Learn | The expert works and talks. Vision describes any screen as a `screen_activity` observation: the app, what is open, what changed, the control about to be used, and labelled regions. At natural pauses Clipa asks **narrow questions that point at one or several places on the screen**. The places are highlighted on the preview. Target: at least 3 questions, at least 1 about a guardrail. | A (generic vision, regions), B (timing policy, `generic_question`, highlights) |
| 3 | Language | The expert may switch language mid-session, for example to Russian or German. Clipa switches too and stays in the new language, including the app's own questions. Show this on purpose; it was the liveliest moment of the first real session. It also covers the brief's stretch goal: the expert explains in one language and the tutor teaches in English. | B (prompts, language detection) |
| 4 | Review (reflection) | The Work Map is built from the session by `map_synthesis`. A reason stands only with the expert's own words. On the briefing board Clipa points at regions of the evidence frames. The user can **talk to Clipa and click places on the board** to discuss a step, a guardrail or a gap. The board asks the gaps as follow-ups, then reads a teach-back for the expert to confirm or correct. Clipa stays present across every tab. | B (board, interactive Clipa), A (evidence frames, replay) |
| 5 | Teach | A new hire works on a new case in the same app. At a pause before a pending action covered by a confirmed guardrail, the tutor warns by voice, highlights the place and offers the expert's moment, through `guardrail_check`. Honest wording: the tutor warns, it never blocks the other app. | B (tutor), A (replay) |
| 6 | Wrap-up | What is mastered, what to practise, and the map export. | B |

Feedback from the first live session (04:00 UTC): keep live questions short and save the dense ones for Review. Feedback from users during use should also be captured as product events.

## v1 (fallback): the customer_07 run in our demo workspace

Status: **approved by Ivan on 4 Oct, 03:01 UTC (05:01 Vienna) as the internal demo v1**. It is the target for building and rehearsal now, and Ivan may still adjust it before the pitch. Proposed by B at 02:45 UTC. Stream A can still amend in the Hive demo thread; Ivan decides conflicts. Who plays the expert and the new hire, and whether the customer_12 fact is introduced live, are still open. Times are Vienna. Pitch at 10:00.

### The journey judges see (about 3 minutes, live)

Clipa (the teal paperclip) is the guide throughout. It flies to the next control, says one short line, and never moves while someone types.

| # | Step | What happens on screen | Owner |
| --- | --- | --- | --- |
| 1 | Open | The app opens at the Pages root on a laptop. Clipa greets the user, flies to "Share screen" and says why. | B (shell, Clipa), A (ScreenPanel) |
| 2 | Share | The user clicks, so the picker opens only on a click. A **live mini-preview** of the captured window with masks applied stays visible in the corner while capturing. On a phone without screen sharing, Clipa offers the **camera** (rear camera pointed at a screen) instead. | A (capture, preview, camera source) |
| 3 | Learn (expert) | The expert does the customer_07 task in the demo workspace: order table, then email, then ticket, text instead of the image. The agent asks at natural pauses: at least 3 questions, at least 1 about a guardrail, at least 1 about something visible on screen. The expert answers by voice. | A (workspace, vision), B (policy, voice, map) |
| 4 | Review (briefing board) | Clipa leads the expert to the briefing board, the Work Map: steps with screen moments (Evidence thumbnails, clip replay), the reason in the expert's words, the guardrails, and the open gaps highlighted to invite a click. The agent asks at least 3 follow-ups, then a teach-back. The expert confirms or corrects by voice or with buttons. | B (board, review), A (Evidence, replay) |
| 5 | Teach (new hire) | A second person (or the synthetic new hire) gets a new case, T1. The tutor asks them to predict the next step. They try Send with only the image. Before Send, the checkpoint warns, quotes the expert and replays the expert's moment. They fix the email, and Send is allowed. T2 (text plus image) is allowed without a warning. | A (checkpoint, Preview/Send), B (tutor, voice) |
| 6 | Wrap-up | A mastery summary (what is mastered, what to practise) and the Work Map export. Clipa waves. | B |

### Rules both streams hold

- One session id and one `sessionEpochMs` per run. Every timestamp counts from it (ScreenBridge v1).
- Honesty: the checkpoint works in our demo workspace only. Off-record stops both channels and does not recall what was already sent. Masks do not clean speech. Simulation and synthetic personas are labelled and never presented as live people.
- The personal rule for customer_07 is never pre-written into a prompt. At least one fact is learned live (T5: customer_12 added in Review).
- Fallbacks, in order: the live run with real people; the live stack driven by the synthetic expert and new hire (TASK-3.32: simulated screen share, synthetic voice); a recorded run of the same flow.

### Content A can add (Mac, local)

Proposed: a short real screen recording of the workspace task on a Mac (for the board's replay and the fallback video), a second voice for the new hire, and ideas for the briefing board. Post them as files in a PR under A's paths, or as links in Hive.

### Open questions for A

1. Mini-preview and camera source: can A add both to the capture and ScreenPanel slice before 07:30, or should B draw the preview from `mount.capture`?
2. Is the step table right for the workspace and the checkpoint? What is missing?
