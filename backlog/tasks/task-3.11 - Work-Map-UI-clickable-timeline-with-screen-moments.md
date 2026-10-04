---
id: TASK-3.11
title: 'Work Map UI: clickable timeline with screen moments'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-03 21:11'
updated_date: '2026-10-04 03:21'
labels:
  - stream-b
  - workmap
  - ux
milestone: m-0
dependencies:
  - TASK-3.6
  - TASK-3.8
parent_task_id: TASK-3
priority: high
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
apps/web/features/agent/workmap renders the confirmed or draft map as a chronological clickable timeline of step and guardrail cards. Header shows counts (steps, judgment calls, guardrails). Each card shows the action, the decision, the reason as the expert's quote, scope, exceptions and status, and a thumbnail of the screen moment resolved through resolveEvidence (assetRef). Clicking a card seeks A's ReplayPanel to startMs..endMs. Editing and confirming go through the KnowledgeStore; a card without screen evidence or quote cannot be confirmed and shows the validator message. Used by Review (to confirm) and Teach (to show where a rule came from).

Estimate: about 1.5 h of agent time. Card key: B-workmap-ui.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On the fixture map the timeline is ordered by time, shows the summary counts, and every confirmed step and guardrail card shows a quote and a screen-moment thumbnail
- [ ] #2 Clicking a card seeks ReplayPanel (or its placeholder) to the evidence moment with the evidence id
- [ ] #3 A card without evidence or quote cannot be confirmed and shows the validator message
- [ ] #4 Component tests cover the three card kinds and the unconfirmable state; no change outside apps/web/features/agent
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 03:35 UTC: Ivan wants the screen understanding visible: a storyboard (раскадровка) of the session — keyframes per step with what changed, the reasoning and the schema facts — as the Review briefing board (doc-10 step 4). Built as an isolated component in apps/web/features/agent/workmap, wired into Review after #36.
<!-- SECTION:NOTES:END -->
