---
id: TASK-3.31
title: 'Wire the brain, LLM route and Clipa director into the product shell'
status: To Do
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:59'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the shell's NullBrain (apps/web/features/agent/shell) with packages/agent's ConversationPolicy, map reducer, review and tutor (PR #26), using the LLM-backed extractor, reply classifier and entity resolver over POST /api/agent/llm/:task (PR #27) with heuristic fallback, and replace the lab Clipa with the motion director from apps/web/features/agent/clipa (PR #23). Learn asks at natural pauses through the voice ([ASK]), answers from the transcript go to the map; Review runs follow-ups and the teach-back with confirm/correct by voice or buttons; Teach runs predict-next and the checkpoint with WARN at Send and a replay of the expert's moment. Then the Pages root swaps: the app at the root, the launch page under status/.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With sample observations and a person answering by voice, Learn asks >=3 questions at natural pauses (>=1 guardrail), Review asks >=3 follow-ups and confirms a teach-back, Teach warns before Send with the expert's quote (T1)
- [ ] #2 Clipa flies to the focused element for questions and to Send for WARN, never while the person types
- [ ] #3 LLM failures fall back to heuristics visibly in the debug log; no token or transcript leaks
- [ ] #4 The app is published at the Pages root and the launch page under status/
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
