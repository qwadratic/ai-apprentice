---
id: TASK-3.28
title: >-
  Clipa motion and lifecycle: dock, notice, approach, speak, listen, think, ack,
  retreat, warn, point, off
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:07'
labels:
  - stream-b
  - ux
dependencies: []
parent_task_id: TASK-3
ordinal: 41000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 03:10: use Clipa's existing design (origin/feat/clipa: web/clipa/clipa.js, clipa.svg, preview.html; the lab's port in apps/web/features/agent/lab/src/clipa.ts) and turn it into full motion per the spec (artifact 'Мозг и тело Clipa', section 2): Clipa docks small and half-transparent in a corner, notices (eyes to the focus point), flies on a curve to beside the focused element without covering it, speaks with a bubble, listens (VAD ring), thinks, acknowledges, retreats; Warning near Send in Teach, Pointing at an evidence replay, Off-record grey with closed eyes. Never moves while the person types; one flight per question; reduced motion = fade/teleport. A dependency-free strict-TS module in apps/web/features/agent/clipa/ with a director API driven by the brain's decisions, plus a demo page; the lab, the simulator and the shell import it later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All 11 states and their transitions run in the demo page with the timings from the spec, smooth (no jumps), and the director refuses to move while input is active
- [ ] #2 Approach targets a side of a given element's rect, stays inside the viewport and never covers the element; retreat returns to the dock corner
- [ ] #3 prefers-reduced-motion replaces flights with fades; a video of the demo is recorded
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
