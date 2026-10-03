---
id: TASK-3.18
title: >-
  Pitch: 3-minute walkthrough, Apprentice Test mapping, simulation note,
  moonshot slide
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
labels:
  - stream-b
  - pitch
  - demo
milestone: m-0
dependencies:
  - TASK-3.8
parent_task_id: TASK-3
priority: medium
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
For the 10:00 local pitch at the Vienna hub. Writes docs/pitch/walkthrough.md: a timed 3 minute live script (who plays the expert and who plays the new hire, which sentences the expert says including the live new fact), an answer to each of the five Apprentice Test questions with the demo moment that proves it (when to ask, what to ask, when understood, did the new hire learn, trust and off-the-record with an honest PII statement: manual masks and regex redaction, no claim of full Presidio unless it is built; contextual updates play the role the brief calls client tools for screen events), the honest simulation note (fictional customer_07 and data, simulation of an expert, built-in Preview checkpoint, mocks never shown as live) and a recorded fallback plan. Adds the one-slide moonshot (living company memory that asks only about what changed; people first, then agents) as docs/pitch/moonshot.html plus a PNG, and a README top section with an architecture diagram and the link to the deployed demo and the frozen Mac bonus.

Estimate: about 1.5 h of agent time. Card key: B-pitch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 walkthrough.md has timings that sum to at most 3 minutes (human step: read aloud once with a timer by Ivan)
- [ ] #2 All five Apprentice Test questions map to a named moment of the demo
- [ ] #3 The simulation note and limits are stated in the README and the first demo slide
- [ ] #4 Moonshot slide renders as one page with a path from the MVP to the vision
- [ ] #5 README shows the deployed URL, quick start without secrets and the Mac bonus note (CI-built, not yet run on a Mac); nothing is published outside the repo without an explicit yes from @qwadratic
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
