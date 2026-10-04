---
id: TASK-2.6
title: 'Select baseline workflow prompts from Gmail, Sheets and Maps screen context'
status: In Progress
assignee:
  - '@kigulx'
created_date: '2026-10-04 06:39'
updated_date: '2026-10-04 07:33'
labels:
  - stream-a
  - shared
  - vision
  - policy
dependencies:
  - TASK-3.52
references:
  - >-
    backlog/tasks/task-3.53 -
    Demo-pace-and-the-process-library-in-the-conductor.md
parent_task_id: TASK-2
priority: high
ordinal: 77000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Kirill requests automatic baseline prompt selection while Clipa watches real Gmail, Google Sheets and Google Maps. The observer needs to know the ordinary workflow before any exception is learned. Do not embed scenario twists, reasons or expected expert answers. This is distinct from TASK-3.53, which recognises already learned processes; integrate with that work instead of building a competing selector. Track under stream A to reserve IDs without collisions; agent integration is shared with B.

Baseline Gmail: Clipa observes customer ticket handling: read the customer email, prepare a reply with a greeting, billing period, invoice date, and the corresponding PDF invoice attached; reply data agrees with the invoice.
Baseline Sheets: Clipa observes quarterly reporting: select client invoices by invoice date for the target quarter; calculate billed amount, received payments against those invoices and unpaid balance per company, then totals; unpaid balance equals billed amount minus payments.
Baseline Maps: Clipa observes business-meeting venue selection: compare places in Google Maps and select a venue with rating at least 4.5.
Common behaviour: notice a visible deviation from the applicable baseline, ask why at a suitable pause, listen and clarify scope, then pass the expert explanation and evidence into the existing Review/knowledge flow. The baseline is not a prelearned exception or an expert-confirmed learned fact.

Use only available screen evidence or already authorised metadata. Never require page DOM access or assume the shared browser address bar is visible. Unknown or ambiguous surfaces must not inherit an unrelated prompt. A profile identifies this demo workflow; recognising Gmail alone does not prove every email is an invoice task. Keep baseline profiles and learned knowledge distinct and correctly scoped.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Real screen observations distinguish Gmail, Google Sheets, Google Maps and unknown; the selected app/profile is inspectable and a single ambiguous frame does not cause unstable switching.
- [x] #2 Each supported app loads only its specified short baseline workflow; no scripted exceptions, expert explanations or expected demo outcomes are embedded.
- [x] #3 The selected baseline reaches the live question generation context before judging deviations, and is refreshed or cleared when the app changes; unknown surfaces cannot retain an unrelated baseline.
- [x] #4 The selector integrates with TASK-3.53 learned-process recognition without replacing its work or mixing rules from different processes; app identity and workflow identity remain distinguishable.
- [x] #5 Deviation questions feed the existing explanation, Review and knowledge flow with process/profile identity and evidence; documentation states whether storage survives an API restart rather than implying persistence.
- [x] #6 Focused checks cover profile switching, unknown/ambiguous screens and context isolation; provide manual real-Google rehearsal steps without creating a fake Gmail, Sheets or Maps interface.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement an independent screen-owned baseline profile module for the three requested workflows, keeping app identity separate from workflow and learned process identity. 2. Require stable observed app identity, suspend context immediately for unknown or ambiguous frames, and test switching and scope isolation. 3. Agree the B-owned integration seam with TASK-3.53 before connecting question and Review context; retain profile/evidence identity without promoting baseline guidance to expert knowledge. 4. Verify focused tests and typecheck, document real Google rehearsal and current in-memory storage limits, and deliver a separate PR.

5. User explicitly reassigned live integration to A after PR59 merged: connect selector and validated baselineContext to conductor questions; clear stale app context, retain profile/evidence provenance in existing Review maps, and verify with Astra medium agents.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Started the independent profile module while TASK-3.52 integration is pending; the baseline live integration depends on generic observations and B seam agreement.

Independent baseline catalog/selector implemented with 10 passing focused tests: stable two-observation recognition, exact app names, immediate suspension on unknown/ambiguous/switching frames, immutable bounded evidence and explicitly unlearned workflow context. B merged generic vision as PR #57 at 155c573; A will not duplicate it. User reports B is resolving the overlap, so conductor/LLM/Review integration is held for agreed handoff. README documents the precise seam and live rehearsal. No claim that the module is live or that TASK-2.6 acceptance criteria are complete.

User explicitly clarified that B owns live conductor integration and A should hand off the ready module only. Exports are BaselineProfileSelector, baselinePromptContext and strict parseBaselinePromptContext. Focused module suite is now 13/13 passing; independent review found no blocking issues. A full npm run check passed before the final parser-only addition; final focused tests and root typecheck passed after it. No B-owned files changed. Follow the module README for the exact remaining live/Review seam; keep task In Progress.

User now explicitly requests A to finish live integration instead of B, using Astra medium subagents. Starting from current origin/main efc1c6e after merged PR59, in isolated codex/task-2.6-live-baselines branch. No duplicate catalog or process recognizer.

Live integration completed on top of merged PR60/main1ed9285: per-session selector feeds separate canonical baselineContext, scoped lifecycle and async invalidation, recognized-process Teach rules, bounded Review provenance, authenticated status diagnostics. Independent Astra medium review found three lifecycle/recognition regressions, all fixed and covered; final merged-head review found no blockers. Full npm run check passed (typecheck, all tests, production build); real-Google recognition and live provider quality remain an explicitly pending manual rehearsal under AC1. Keep In Progress until that acceptance check is performed; maps remain in API memory.
<!-- SECTION:NOTES:END -->
