---
id: TASK-4
title: VM backend on exe.dev
status: To Do
assignee:
  - '@qwadratic'
created_date: '2026-10-03 20:54'
labels:
  - shared
  - infra
milestone: m-0
dependencies: []
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Separate exe.dev VM for the API: SQLite and redacted media on disk, HTTPS, deploy from main, an internal claude-runner on the Claude Agent SDK for vision and text calls, env file with keys outside git. Delegated by @qwadratic to an agent on the VM; brief in the backlog docs.
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
