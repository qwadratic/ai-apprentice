---
id: TASK-3.30
title: 'LLM route for the brain: POST /api/agent/llm/:task via the VM runner'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:50'
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
- [ ] #1 Each task validates input and output; a hallucinated quote, field or ref is rejected
- [ ] #2 Prompts contain no scenario rule (grep test); the route cannot be used as a free chatbot
- [ ] #3 Tests with a fake runner cover auth, limits, timeouts and schema rejection
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
