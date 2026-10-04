---
id: TASK-3.30
title: 'LLM route for the brain: POST /api/agent/llm/:task via the VM runner'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:50'
updated_date: '2026-10-04 02:02'
labels:
  - stream-b
  - api
dependencies: []
parent_task_id: TASK-3
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The brain's heuristics fail on free speech (Opus review of TASK-3.29). apps/api/agent gets POST /api/agent/llm/:task (answer_extraction, reply_classification, entity_resolution): session-token auth, per-session and per-IP limits, 16 KiB cap, server-side generic prompts and JSON schemas, calls the Claude runner with structured output, validates the output, never logs inputs or outputs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each task validates input and output; a hallucinated quote, field or ref is rejected
- [x] #2 Prompts contain no scenario rule (grep test); the route cannot be used as a free chatbot
- [x] #3 Tests with a fake runner cover auth, limits, timeouts and schema rejection
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [x] #2 Fast checks of the touched package pass; CI is green on the branch head
- [x] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #27 (c6806da). apps/api/agent adds POST /api/agent/llm/:task for answer_extraction, reply_classification and entity_resolution. Server-side generic prompts with pinned hashes, JSON schemas with length caps, normalised quote matching against the input, ref checks. Limits: session 6/min and 60/h, IP 20/min and 200/h, global 600/h; one call in flight per session and one globally (429 busy). The runner gets /v1/complete with a $0.10 budget for text calls and stops a call when the client disconnects. Verified by apps/api/test/agent-llm.test.ts with a fake runner (auth, limits, timeouts, schema and quote rejection, honesty test on what the runner receives), root npm run check on Node 22.22.0 and 24, and an Opus re-review that passed at 914f9d1. Follow-up for the brain: queue calls and fall back to heuristics on 429.
<!-- SECTION:FINAL_SUMMARY:END -->
