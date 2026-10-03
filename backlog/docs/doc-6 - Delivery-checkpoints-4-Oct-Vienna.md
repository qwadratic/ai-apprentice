---
id: doc-6
title: Delivery checkpoints - 4 Oct Vienna
type: guide
created_date: '2026-10-03 22:19'
updated_date: '2026-10-03 22:20'
---
# Delivery checkpoints for 4 October 2026

All times are Europe/Vienna (CEST, UTC+02:00), on 4 October. Baseline review: 00:20. Targets below are a proposed coordination schedule, not promises from stream B or new completion claims. Pitch at 10:00 and submission at 15:00 are recorded in CLAUDE.md and milestones m-0/m-1. Confirm availability at the first A/B sync; reforecast explicitly when a target slips.

## Checkpoints and evidence

| Target | Stream A (@kigulx) | Stream B (@qwadratic), proposed | Joint exit evidence |
| --- | --- | --- | --- |
| 00:45 | TASK-2.1 foundation commit and ScreenBridge proposal aligned with B; TASK-2.4 fixture/heartbeat compatibility review | Review TASK-1 proposal against TASK-3.1 draft; confirm voice spike status and app/API mount points | Exact base SHA, one field/method table approved by both owners, named owners for adapters; explicitly pending items stay pending |
| 01:30 | Connect processed capture, vision and Evidence through the agreed bridge on a feature/integration branch | Attach agent and voice to the same session; confirm runner/backend availability with TASK-4 owner | One real masked screen becomes a real observation and resolvable frame Evidence, and reaches the agent; record provider latency and run commands; mock-only output is a partial pass |
| 02:30 | Preview/Send uses current order and email observations; pause/stop invalidate work; begin TASK-2.5 only after claiming it and pinning capture/Evidence bases | Learn question/answer creates an evidence-linked rule; off-record reaches A; Review displays that source | Demonstrate edit during pending analysis, unknown customer, provider failure and off-record without stale approval or further outgoing frames |
| 04:00 | Processed recording, clip Evidence mapping and ReplayPanel; scenario reset; runtime adapters | Complete Learn -> Review -> Teach, with warning and explicit human Send decision | One recorded full run: expert teaches a rule, review confirms it, tutor catches new-order mismatch and explains the source; actual clip replay verified |
| 07:30 | Fix only blocking capture/checkpoint/replay issues | Fix only blocking agent/voice/session issues | Two consecutive timed runs, including a new fact for customer_12 applied to a different order; retain run SHA and evidence |
| 08:30 | Freeze chosen demo branch revision; support backup recording | Finish pitch/demo script and honest fallback recording | Rehearsal fits the agreed presentation duration; backup verified; fake/provider-offline segments clearly identified |
| 09:15 | Browser, screen permission, masks and connectivity check on the presenting machine | Voice/audio and presenter check; open the chosen demo build | Go/no-go checklist with an explicit fallback choice and no new feature work |
| 10:00 | Support live demo | Local pitch | Pitch milestone m-0 |
| 13:30 | Resolve submission-blocking defects only | Finalize required submission materials and links | Final materials checked by the human owner; deployment/merge policy explicitly resolved |
| 14:15 | Support technical verification | Human submits and verifies receipts | Target 45-minute buffer before the recorded 15:00 deadline; no automatic form submission authorized here |

If the 01:30 real-data gate fails, spend the next 20 minutes on the single earliest failing hop and reforecast the later targets. Continue independent work with mocks but never count that as real integration. If the 04:00 full run fails, stop optional UI polish and extra scenarios; preserve masking, off-record, unknown/error handling and human control of Send. A missed target is not a reason to mark work Done or merge code to main.

## Coordination protocol

- The two human owners sync for five minutes at 00:45, 01:30, 02:30 and 04:00, and after any shared contract change. Later syncs follow the gates above. These are proposed meetings, not calendar invitations.
- Every 20 minutes the coordinator checks the worker chats. Report only a meaningful change, blocker or decision. During active work in the coordinator chat, provide progress updates at least once a minute.
- Handoff format: TASK, owner, branch and exact SHA, changed paths, actual check command/result, untested behavior, next target, blocker and who can unblock it. Track Ready for integration in notes; task status stays In Progress until the authorized merge.
- Escalate a shared blocker after 15 minutes without progress; name the one decision or artifact needed. Do not let all workers implement competing versions of the contract.
- Foundation worker alone owns root dependencies and lockfile. Capture, vision/API and demo workers edit their assigned directories in separate worktrees. B owns its agent, voice and product shell. Connecting A modules must not overwrite B's app shell.
- Start TASK-2.5 in a separate task branch only after its claim is on main and the required capture/Evidence revisions are pinned. The capture worker is the natural next owner, but this schedule does not itself claim or start that task.

## Baseline review and concrete gaps

- TASK-2.2 implementation commits 5b92f05 and d559334; handoff 64eb3f3. Coordinator independently ran 15 capture tests on Node 22.22.0: all passed. Real browser picker and OS permissions remain unverified in this review.
- TASK-2.4 implementation 9a19f4c. Coordinator independently ran 23 workspace tests on Node 22.22.0: all passed. Real bridge/voice integration remains unverified. Compatibility follow-up sent to the worker: align fixture data with B, provide two distinct spare-customer orders, and implement the agreed typing/idle heartbeat adapter.
- TASK-2.3 implementation 3e7297c; handoff 05f84ea. Coordinator independently ran 35 queue/API/runner-client tests on Node 22.22.0: all passed. These use injected/synthetic dependencies, not the real provider. Historical observations are separated from checkpoint eligibility. The provisional 75-second history limit and 2.5-second checkpoint age need real latency testing. The HTTP route currently yields history-only frames until trusted source-revision tracking is connected.
- TASK-2.1 active branch is codex/task-2.1-web-foundation, worktree web-foundation. The older task-2.1-web-foundation worktree/chat is obsolete; do not start both. Its current contract is still a proposal, not approved TASK-1.
- Stream B has published origin/task-3.1-mocks-contract at 30865d6 and origin/task-3.2-elevenlabs-spike. The coordinator inspected the contract and fixture requirements, but has not verified B's test/voice claims.
- Actual schema mismatches found between A's current proposal and B's draft: order vs order_view; ticket status/summary vs status/note; input_activity fields; nullable frame/address/window; missing onCheckpoint/replyToCheckpoint in A's ScreenBridge. Foundation worker has been asked to reconcile proposals and test compatibility; both owners must still approve the contract.
- File ownership review found no current overlap among the four A worker slices or with B feature directories. Shared interface compatibility, root/app mount points and scenario fixtures remain integration risks.

Commands independently rerun by the coordinator, with /private/tmp/ai-apprentice-foundation-tools/node_modules/node/bin/node (v22.22.0), in the respective worker worktrees:

    node --test packages/screen/capture/tests/capture.test.mjs
    node --test apps/web/features/demo-workspace/tests/workspace.test.ts
    node --test packages/screen/vision/queue.test.mjs apps/api/screen/runner-client.test.mjs apps/api/screen/screen.test.mjs

73 tests passed in total. This does not establish browser/OS behavior, provider quality, CI success or end-to-end demo readiness.

## Publication rule requiring coordination

The direct instruction in the Codex coordinator chat remains: only Backlog goes to main; code and contracts stay on separate branches. Newly fetched decision-1 permits a different coordinator to merge B-only PRs after CI and review. This is a policy discrepancy to resolve with the human owners before code merges or deployment assumptions. This schedule does not amend decision-1 or authorize such a merge. Work and integration checks can continue on task branches meanwhile.
