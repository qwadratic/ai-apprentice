---
id: TASK-3.31
title: 'Wire the brain, LLM route and Clipa director into the product shell'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:59'
updated_date: '2026-10-04 02:15'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Branch task-3.31-wire-brain from task-3.29-brain (stacked on PR #26; merge main and #26 in as they land).
2. Adapter from the shell's BrainDecision (shell/brain/types.ts) to packages/agent's policy output; one shared LlmClient for extractor, classifier and resolver; known customers from the workspace cases.
3. Replace NullBrain: Learn (ASK_NOW at pauses via [ASK] contextual updates, answers to the map), Review (follow-ups, teach-back, confirm/correct by voice or buttons), Teach (predict-next, checkpoint WARN before Send with the expert's quote and moment).
4. Replace the lab Clipa with the director from apps/web/features/agent/clipa; move the voice code still imported from features/agent/lab into the shell, then delete features/agent/lab.
5. Adapters to stream A's contracts only (decision-4): ScreenBridge v1 types from packages/contracts, checkpoint reply within 4 s with an unknown fallback; the workspace and the real screen bridge mount after PR #12 and #21 merge.
6. Align B fixtures with the workspace (customer_07 ref, DEMO-1201/1202, explicit acknowledgement on warn/unknown, Reset starts a new session).
7. Pages root swap stays a separate follow-up.
<!-- SECTION:PLAN:END -->
