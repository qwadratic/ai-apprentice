---
id: TASK-3.55
title: >-
  Demo mode: Clipa recognises the demo task, keeps it short and handles
  off-script users
status: To Do
assignee: []
created_date: '2026-10-04 06:07'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 73000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 06:25 UTC: the demo task needs a marker, so Clipa recognises that this is the demo scenario and is ready. In demo mode she knows she is in a demo and moves things along quickly. When the user does not do what is expected, she steers back naturally, and for fun she may hint what to do next. She also prompts the language switch. Builds on process recognition (TASK-3.53): a demo process with a marker (a title or a visible marker on the demo surface), a demo flag in the conductor, shorter budgets, gentle nudges and a language-switch line.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A visible demo marker puts the conductor in demo mode
- [ ] #2 Demo mode: shorter timing, nudges when the user goes off script, one hint line
- [ ] #3 A language-switch prompt at a fixed point in the demo
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
