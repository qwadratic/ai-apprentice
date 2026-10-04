---
id: TASK-3.19
title: 'Video scripts and shot lists for demo, tech and team videos'
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
updated_date: '2026-10-04 08:17'
labels:
  - stream-b
  - pitch
  - demo
milestone: m-1
dependencies:
  - TASK-3.18
parent_task_id: TASK-3
priority: medium
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agents prepare content while Ivan and @kigulx do the recording (human steps). Writes docs/pitch/video-demo.md (problem, solution, UI), docs/pitch/video-tech.md (ScreenBridge, privacy before transmit, ElevenAgents with the policy coordinator, Work Map reducer with evidence validation, Claude Agent SDK on the exe.dev VM, complexity, with/without-expert table if built) and docs/pitch/video-team.md (outline for @kigulx and @qwadratic to fill in with their own words), each with shot list and timing. Check the length rules in Discord before fixing the timings. Produces the architecture diagram image for the tech video.

Estimate: about 1 h of agent time. Card key: B-video-scripts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Three scripts and shot lists exist and each states its timing against the length rules confirmed in Discord
- [ ] #2 The architecture diagram image is committed and matches the actual repo structure
- [ ] #3 Scripts do not claim features that are not built (checked against the cut list), and say that the expert is a simulation
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 08:16 UTC: docs/pitch/video-demo.md (product walkthrough, 2:00 + 60 s cut) and docs/pitch/video-tech.md (technical walkthrough with a Mermaid architecture diagram) merged in PR #66. Still open: the team video outline, the length rules from Discord, a rendered diagram image.
<!-- SECTION:NOTES:END -->
