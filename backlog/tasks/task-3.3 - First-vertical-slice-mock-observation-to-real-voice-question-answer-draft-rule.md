---
id: TASK-3.3
title: >-
  First vertical slice: mock observation to real voice question, answer, draft
  rule
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
updated_date: '2026-10-03 22:17'
labels:
  - stream-b
  - voice
  - policy
  - ux
milestone: m-0
dependencies:
  - TASK-3.1
  - TASK-3.2
parent_task_id: TASK-3
priority: high
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implements the real ElevenLabs adapter behind the VoiceAdapter interface and the first end-to-end loop on mocks. apps/api/agent gets POST /api/agent/signed-url (role interviewer|tutor) that mints a signed URL with the server key, exported as mount(app) with a dev-only server in apps/api/agent/dev-server.ts until the skeleton lands. The browser enforces a 10 minute client timer (endSession) and the server keeps a daily minutes budget, per-IP and global rate limits and a kill-switch env var, because a signed URL cannot be capped server-side. packages/agent gets ElevenLabsVoiceAdapter (startSession, contextual updates for observations, ask() via sendUserMessage with an orchestrator marker, onMessage to timestamped transcripts, onModeChange to listening/speaking, vad, errors) and one ConversationCoordinator that owns all speech. A question counts as asked only after it was spoken, derived from onMessage(source ai) plus onModeChange speaking to listening (or agent_response_correction after an interruption). apps/web/features/agent/slice shows a minimal page: FakeScreenBridge replay, the question 'why text instead of the template screenshot', the spoken answer, and a draft rule with the quote and evidence id (a heuristic stub, real extraction comes in B-knowledge-engine).

Estimate: about 2 h of agent time. Card key: B-voice-slice.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With a real key the mock stream leads to one spoken question at a pause, the user answers by voice, the transcript appears, and a draft rule {condition, requiredAction, quote, evidenceId, status: proposed} is shown
- [ ] #2 The same loop passes in CI with FakeVoiceAdapter and no keys
- [ ] #3 Coordinator states listening, speaking, thinking, paused, error are visible; a second speaker request while speaking is queued, never overlapped
- [ ] #4 A question is marked asked only on the 'spoken' signal and the chosen signal is documented; a cancelled or expired one stays pending
- [ ] #5 signed-url endpoint: the browser bundle contains no ELEVENLABS_API_KEY (grep in a test), requests from other origins are rejected, the per-IP and global rate limit and the daily minutes budget refuse new URLs when exceeded, the kill switch returns 503, and the client ends a session at 10 minutes
- [ ] #6 Round-trip latency (observation to first audio) is displayed in the debug panel
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @qwadratic
created: 2026-10-03 22:17
---
Coordinator decision: for now the signed URL route is GET {api}/agent/elevenlabs/signed-url?role=interviewer returning {signed_url}, served by the VM placeholder API (infra/, origin check + rate limit, no token). The agent lab page (TASK-3.21) already calls it. When apps/api/agent takes over, keep this route or change both together.
---
<!-- COMMENTS:END -->
