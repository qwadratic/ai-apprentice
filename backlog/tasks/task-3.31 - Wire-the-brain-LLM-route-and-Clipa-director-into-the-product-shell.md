---
id: TASK-3.31
title: 'Wire the brain, LLM route and Clipa director into the product shell'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 01:59'
updated_date: '2026-10-04 06:06'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 04:20 UTC, handoff. Branch task-3.31-fixes at b8559bc (cut from main ae52ad2), pushed, no PR yet. Root npm run check passes (web 170/0), plus a local headless browser run. Fixes:
1. 'Mode flapping' was the SDK's speaking/listening log; it is now VOICE_MODE and logged only on change. Tabs only switch the view; an explicit 'End X and start Y' button switches sessions.
2. Learn writes the SKIP reason every 20 s and shows it. Key presses on our page reach the policy's typing channel.
3. Teach checkpoint: screen/checkpoint-binding.ts keeps the shell's port on the workspace. Outside Teach, Preview answers unknown with 'Start Teach first'.
4. A per-frame vision error now shows 'last frame skipped', not 'stopped'.
5. Review with a thin map says 'Run Learn first' (this edits ReviewView.tsx).
Root cause of 3 and 4 is in stream A's code: the runtime.bridge.onStatus handler in apps/web/features/demo-workspace/mountRuntimeWorkspace.ts disconnects the checkpoint port and drops the heartbeats on any status other than capturing; stream A should fix it there.
Next: open the PR, merge after CI, post the head to the devops session for the VM rerun (TASK-3.42). Screenshots: coordinator scratchpad fix-*.png.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Merged: PR #36 (brain, LLM route and director wired into the shell) and PR #44 (fixes from the first VM run). The conductor (TASK-3.44/3.46) now leads; the in-browser brain is the fallback (?conductor=off).
<!-- SECTION:FINAL_SUMMARY:END -->
