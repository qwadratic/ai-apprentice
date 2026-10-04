---
id: TASK-3.52
title: 'Generic vision: screen_activity observations with regions for any app'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 06:01'
updated_date: '2026-10-04 08:17'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 70000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan's demo runs on any app (an email, a table), on the web and on macOS. The vision path today returns vision_incomplete for anything that is not order, email or ticket. Add the screen_activity kind proposed in the Hive integration thread (TASK-3.41): {app, surface, summary, change, entities, pendingAction, pendingRegionId, regions:[{id,label,box}]}. It is additive in contracts and the vision contract and keeps the masks. Stream A's area; done by B on Ivan's line to not wait.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The vision schema and parser accept screen_activity; contracts know the kind
- [x] #2 An unknown app is described instead of incomplete; existing kinds are unchanged
- [x] #3 Tests cover the parse and the conductor receives it
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 06:30 UTC: not started. The contract is in the Hive integration thread and TASK-3.41 notes; the conductor already parses screen_activity (apps/api/agent/conductor/protocol.ts).

Kirill explicitly assigned TASK-3.52 to a new Codex orchestrator in the status chat on 4 Oct. Stream A resumes its vision/contracts implementation; preserve the existing additive screen_activity proposal and coordinate with B rather than duplicating TASK-3.53. Use an isolated worktree. Slack is forbidden.

4 Oct 07:10 UTC: B's implementation merged as PR #57 (155c573) and deployed; the Reflect board groups by process in PR #58 (aea99ef). Stream A built the same contract in parallel (PR #56) after Kirill's assignment at 7ae458d, which B's claim a34f50a overwrote by mistake. #57 went first for the pitch because frames with a known workspace surface keep the old prompt and schema (hash-pinned) and reject screen_activity, plus the VISION_GENERIC=off kill switch. A's improvements (branding-only app identity, no DOM inference, x+w<=1, tests for Gmail/Sheets/Maps payloads, region cues, typing, off-record) are being ported onto main by B with co-author credit (branch task-3.52-port-a), to merge after the pitch; then #56 closes as included. Live check on real Gmail/Sheets still pending (dry run 07:35).

4 Oct 07:32 UTC: PR #60 merged (1ed9285) and deployed. (1) Conductor fix: the vision model rewords screen_activity summaries on every frame, so every frame counted as a change, the pause never came and every prepared question was aborted; now only another app, surface or pending control restarts the pause. (2) Stream A's #56 delta ported with co-author credit (generic-path prompt rules, clamp, dedup, A's Gmail/Sheets/Maps tests, README). #56 closed as included. Found by a live smoke at 07:20: the VM's Claude runner fails every call (runner_error), so no vision at all; Ivan is switching the runner to ANTHROPIC_API_KEY.

4 Oct 08:16 UTC: the VM runner runs on the Codex CLI engine (PR #63, RUNNER_ENGINE=codex, default model; luna and sol-5.6 reject images). Live smoke at 08:12: vision ~11 s per frame, the question ~13 s after the pause. PR #62 sends each new screen to the voice agent as a [screen] contextual update (commit labelled TASK-3.57 by mistake; that task is Off the record). Faster vision (smaller frames + a storyboard of recent frames) is being built on task-3.52-vision-storyboard.
<!-- SECTION:NOTES:END -->
