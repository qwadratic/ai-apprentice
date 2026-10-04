---
id: TASK-3.58
title: 'Clipa''s brain as a reusable service: MCP server or SDK for any front end'
status: To Do
assignee: []
created_date: '2026-10-04 06:07'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: medium
ordinal: 76000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 06:25 UTC: wrap Clipa's brain (the conductor) so any front end can reuse it, for example as an MCP server. Clipa moves around the screen, adapts to the current screen, and recognises the app and the task inside it. The conductor already has an HTTP API (doc-12); add an MCP server (tools: start session, push events, read cues, get the map, list learned processes) and a small client SDK. App and task recognition builds on TASK-3.53.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An MCP server exposes the conductor's session, events, cues, map and process library
- [ ] #2 A front end other than the web and macOS apps can drive Clipa through it
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
