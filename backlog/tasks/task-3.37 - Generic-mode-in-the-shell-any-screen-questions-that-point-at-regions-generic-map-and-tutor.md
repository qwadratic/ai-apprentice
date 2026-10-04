---
id: TASK-3.37
title: >-
  Generic mode in the shell: any screen, questions that point at regions,
  generic map and tutor
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 04:06'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 55000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Shell side of the generic mode: render screen_activity observations, send a [screen] line only on change, ask at pauses through generic_question and highlight the regions on the screen preview, follow the expert's language, build the Review map through map_synthesis, and warn in Teach through guardrail_check. Depends on stream A's screen_activity observation kind.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Learn asks at least 3 narrow questions on an arbitrary shared screen, each at a pause, with the regions highlighted
- [ ] #2 Review builds the map from the session and ends with a confirmed teach-back
- [ ] #3 Teach warns before a pending action covered by a confirmed guardrail; honest wording: warn, never block
- [ ] #4 Verified in a real browser with a synthetic screen_activity source
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
