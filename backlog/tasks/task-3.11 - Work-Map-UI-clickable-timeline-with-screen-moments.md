---
id: TASK-3.11
title: 'Work Map UI: clickable timeline with screen moments'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 21:11'
updated_date: '2026-10-05 08:58'
labels:
  - stream-b
  - workmap
  - ux
milestone: m-0
dependencies:
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

4 Oct 04:15 UTC, handoff. PR #42 merged WorkMapBoard (apps/web/features/agent/workmap). It is not mounted in Review yet. A builder read the code for mounting it and the interactive Clipa, and stopped at the wind-down with nothing pushed. Its findings:
1. Shell state is too thin for the board. The store has draftMap (lossy, guardrails as text), review.gaps without regionIds, and observation rows without facts. The full WorkMap sits behind the private AgentBrain.state, and full observations only pass through the private controller.onObservation. reviewStatus().openFollowUps and .blockers are not exposed. Right fix: a controller hook such as workMap() plus an observation tap. Quick fallback: a lossy fromDraftMap(draftMap, gaps, rows) in workmap/.
2. buildKeyframes in workmap/model.ts treats every observation that is not input_activity as email_draft, and would throw on screen_activity (it reads facts.attachments). It needs a screen_activity branch (app/surface/change, Keyframe.regions, Surface widened to string).
3. evidenceIds in map_synthesis output are observation ids. fromGenericMap must map them to each observation's evidenceIds. Region boxes come from facts.regions[].box on the screen side.
4. Clipa pointing: targets resolve via [data-clipa-surface][data-clipa-hint] (shell/clipa/targets.ts). The director's point() is not reachable from views; the presenter's point is fixed to REPLAY_TARGET. Expose pointAt(target) on ShellRuntime (runtime.ts, director-presenter.ts).
5. Voice: 'Answer this' and 'Ask Clipa about this' need a public controller method for [ASK] and for the contextual send; today sendContext is private.
6. Layout: no CSS needed, because ReviewView already gets the wide 3fr column in Review.
Next steps: workmap/generic-map.ts (fromGenericMap with a test), then the screen_activity keyframes with region boxes and a synthetic fixture, then mount in ReviewView, then the controller hooks.

Docs-cleanup audit (2026-10-05): AC2 (clicking a card seeks the replay to the evidence moment) is contradicted by the shipped product's own honesty section (README: a video replay of that screen moment is not wired into the Work Map yet). AC1, AC3 and AC4 need a live browser session or a test run to verify properly and were not exercised in this pass; left unchecked.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
WorkMapBoard merged (PR #42) and mounted in Reflect by the conductor client (PR #52, fromGenericMap adapter, screen_activity keyframes).
<!-- SECTION:FINAL_SUMMARY:END -->
