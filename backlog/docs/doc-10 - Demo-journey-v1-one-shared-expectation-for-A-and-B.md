---
id: doc-10
title: Demo journey v1 - one shared expectation for A and B
type: specification
created_date: '2026-10-04 02:44'
---

# Demo journey v1: one shared expectation for A and B

Status: **approved by Ivan on 4 Oct, 03:01 UTC (05:01 Vienna)**. Proposed by B at 02:45 UTC. Stream A can still amend in the Hive demo thread; Ivan decides conflicts. Who plays the expert and the new hire, and whether the customer_12 fact is introduced live, are still open. Times are Vienna. Pitch at 10:00.

## The journey judges see (about 3 minutes, live)

Clipa (the teal paperclip) is the guide throughout. It flies to the next control, says one short line, and never moves while someone types.

| # | Step | What happens on screen | Owner |
| --- | --- | --- | --- |
| 1 | Open | The app opens at the Pages root on a laptop. Clipa greets the user, flies to "Share screen" and says why. | B (shell, Clipa), A (ScreenPanel) |
| 2 | Share | The user clicks, so the picker opens only on a click. A **live mini-preview** of the captured window with masks applied stays visible in the corner while capturing. On a phone without screen sharing, Clipa offers the **camera** (rear camera pointed at a screen) instead. | A (capture, preview, camera source) |
| 3 | Learn (expert) | The expert does the customer_07 task in the demo workspace: order table, then email, then ticket, text instead of the image. The agent asks at natural pauses: at least 3 questions, at least 1 about a guardrail, at least 1 about something visible on screen. The expert answers by voice. | A (workspace, vision), B (policy, voice, map) |
| 4 | Review (briefing board) | Clipa leads the expert to the briefing board, the Work Map: steps with screen moments (Evidence thumbnails, clip replay), the reason in the expert's words, the guardrails, and the open gaps highlighted to invite a click. The agent asks at least 3 follow-ups, then a teach-back. The expert confirms or corrects by voice or with buttons. | B (board, review), A (Evidence, replay) |
| 5 | Teach (new hire) | A second person (or the synthetic new hire) gets a new case, T1. The tutor asks them to predict the next step. They try Send with only the image. Before Send, the checkpoint warns, quotes the expert and replays the expert's moment. They fix the email, and Send is allowed. T2 (text plus image) is allowed without a warning. | A (checkpoint, Preview/Send), B (tutor, voice) |
| 6 | Wrap-up | A mastery summary (what is mastered, what to practise) and the Work Map export. Clipa waves. | B |

## Rules both streams hold

- One session id and one `sessionEpochMs` per run. Every timestamp counts from it (ScreenBridge v1).
- Honesty: the checkpoint works in our demo workspace only. Off-record stops both channels and does not recall what was already sent. Masks do not clean speech. Simulation and synthetic personas are labelled and never presented as live people.
- The personal rule for customer_07 is never pre-written into a prompt. At least one fact is learned live (T5: customer_12 added in Review).
- Fallbacks, in order: the live run with real people; the live stack driven by the synthetic expert and new hire (TASK-3.32: simulated screen share, synthetic voice); a recorded run of the same flow.

## Content A can add (Mac, local)

Proposed: a short real screen recording of the workspace task on a Mac (for the board's replay and the fallback video), a second voice for the new hire, and ideas for the briefing board. Post them as files in a PR under A's paths, or as links in Hive.

## Open questions for A

1. Mini-preview and camera source: can A add both to the capture and ScreenPanel slice before 07:30, or should B draw the preview from `mount.capture`?
2. Is the step table right for the workspace and the checkpoint? What is missing?
