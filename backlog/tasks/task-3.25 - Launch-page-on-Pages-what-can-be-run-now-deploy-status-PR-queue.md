---
id: TASK-3.25
title: 'Launch page on Pages: what can be run now, deploy status, PR queue'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 00:12'
updated_date: '2026-10-04 00:37'
labels:
  - stream-b
  - ux
dependencies: []
parent_task_id: TASK-3
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 00:15: the team needs one page to start things from. The Pages root becomes a launch page; the agent lab moves to /lab/. Cards for what can be run now (agent lab with live voice; stream A's demo workspace and foundation once merged), live status (web sha from deploy.json, API /health and last VM deploy), and the PR queue by status label read from the public GitHub API. Strict TypeScript like the lab.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The Pages root shows the launch cards; the lab works unchanged at /lab/
- [x] #2 Status shows web sha, API health and runner, and whether web and API run the same sha
- [x] #3 Open PRs are listed with their status label and link; the page still renders when the GitHub API or the VM is down
- [x] #4 No token or secret in the page or the build
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
PR #17 merged (aef7f1e): strict-TS launch page at the Pages root (run cards, deploy status for web/API/VM deploy, PR queue by decision-2 labels), lab moved to /lab/, rollback-tolerant pages-build. Verified by local builds, workflow script runs, headless Chromium at the real origin, and an Opus verifier (PASS).
<!-- SECTION:FINAL_SUMMARY:END -->
