---
id: TASK-6.3
title: 'Workspace CI: root npm ci and npm run check on workspace PRs'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 00:09'
labels:
  - shared
  - infra
dependencies: []
parent_task_id: TASK-6
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Stream A's foundation (PR #14) adds a root npm workspace, but A's publishing credential cannot add workflows. Add .github/workflows/workspace-checks.yml: on pull_request (and workflow_dispatch with a ref) run npm ci and npm run check on Node 22.22 and 24 when a root package-lock.json exists. Existing workflows stay untouched; release gating on it is coordinated with A once the integrated app is ready.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PRs touching package.json, package-lock.json, apps/, packages/ or tsconfig.base.json run npm ci and npm run check on Node 22.22 and 24
- [ ] #2 The job is skipped cleanly on refs without a root package-lock.json
- [ ] #3 A manual run with ref=codex/task-2.1-foundation-pr checks PR #14 before its next push
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
