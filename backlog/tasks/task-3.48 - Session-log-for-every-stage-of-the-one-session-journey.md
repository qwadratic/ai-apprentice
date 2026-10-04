---
id: TASK-3.48
title: Session log for every stage of the one-session journey
status: To Do
assignee: []
created_date: '2026-10-04 05:40'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: medium
ordinal: 66000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since PR #52 the web runs Show, Reflect and Pass it on in one session, because the conductor is keyed by session id. POST /api/agent/sessions/:id/finish is called at the end of each stage. A second finish may store no transcript, or answer 409 while the first one is still running. Store each stage's conversation (one ElevenLabs conversation per stage) under the same session.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each stage's transcript is stored once, under the same session id
- [ ] #2 A finish while the previous one runs is queued, not refused
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
