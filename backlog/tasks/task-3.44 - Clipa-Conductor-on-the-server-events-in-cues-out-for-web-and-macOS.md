---
id: TASK-3.44
title: 'Clipa Conductor on the server: events in, cues out, for web and macOS'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 04:25'
updated_date: '2026-10-04 05:02'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement doc-12, which Ivan approved on 4 Oct at 04:33 UTC: the conductor runs on the server. The work: SSE cue stream and POST events under /api/agent/conductor/:sessionId, the token in the Authorization header, and the conductor state per session. Learn timing and generic_question; Review with map_synthesis, gaps, the teach-back and reply_classification; Teach with guardrail_check and warn. Journey guidance for the expert and the new hire, reusing the DOM-free journey engine from PR #37 moved into a package. Off-record stops cues and aborts LLM calls. The server reads screen observations by session id. No new dependencies. The macOS app is stream A's (Kirill/Codex); the web shell moves to the same cues later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 POST events and the SSE cue stream work with a session token, with replay after a seq on reconnect
- [x] #2 Learn: an ask cue at a pause after a change, within the budget, with regions
- [x] #3 Review: map, gap asks, the teach-back, and confirm or correct
- [x] #4 Teach: a warn cue before a pending action covered by a confirmed guardrail
- [x] #5 Off-record stops cues and aborts LLM calls; unit tests cover the protocol
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [x] #2 Fast checks of the touched package pass; CI is green on the branch head
- [x] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #49 (1087e5e) and live on the VM. Smoke test against production: session, hello, then the SSE stream delivered state and guide welcome through the proxy without buffering. The PR covers the protocol, the engine (web and macOS faces, hand-over with a join code, prefetched Learn questions with regions, Review with map_synthesis, gaps, teach-back and voice editing through the new map_edit task, the fast Teach check on pending actions, off-record), the fast model for latency-bound tasks and the server-side screen hook. Unit tests: 16 conductor, 1 map_edit route, 1 hub; root npm run check and CI green. Clients still to come: TASK-3.46 (web); the macOS app is stream A's.
<!-- SECTION:FINAL_SUMMARY:END -->
