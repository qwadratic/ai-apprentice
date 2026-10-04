---
id: TASK-3.36
title: >-
  Generic mode on the API: LLM tasks for any screen (question, map, guardrail
  check)
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 04:06'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The live demo runs outside our demo workspace on workflows nobody knows in advance (Ivan, 4 Oct 04:05 UTC). Add three fixed LLM tasks behind POST /api/agent/llm/:task: generic_question (one narrow question at a pause, pointing at screen regions), map_synthesis (a Work Map from observations and the expert's words, quotes verified against the transcript) and guardrail_check (Teach: warn before a pending action that a confirmed guardrail covers).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 generic_question returns a question or null, its topic, and observation and region ids drawn only from the input
- [ ] #2 map_synthesis returns steps, guardrails, gaps and a teach-back; every quote is a span of an expert turn and every evidence id comes from the input
- [ ] #3 guardrail_check returns clear, warn or unknown, plus the guardrail id and the regions; it never invents a guardrail
- [ ] #4 Unit tests cover input rejection and output checks; deployed to the VM
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 04:25 UTC: Ivan raised the runner's per-call budget for text tasks (RUNNER_COMPLETE_MAX_BUDGET_USD on the VM) from 0.10 to 0.50 USD. map_synthesis takes up to 96 KiB of input; at 0.10 it risked error_max_budget_usd (502 sdk_error). Vision calls already had 0.50 (MAX_BUDGET_USD).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged in PR #43: generic_question, map_synthesis and guardrail_check; later map_edit (PR #49). Deployed.
<!-- SECTION:FINAL_SUMMARY:END -->
