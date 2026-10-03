---
id: TASK-3.2
title: 'ElevenLabs integration spike: key, credits, agent config, silence behaviour'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-03 21:10'
updated_date: '2026-10-03 22:22'
labels:
  - stream-b
  - voice
  - infra
milestone: m-0
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
First real ElevenLabs test, done as soon as ELEVENLABS_API_KEY exists in the new cloud session; nothing has been verified against the live API yet. Adds an idempotent provisioning script and agent config under apps/api/agent/elevenlabs/ (interviewer and tutor agents, Claude as the built-in LLM, V3 Conversational TTS for Expressive Mode, empty first message, turn_timeout 30, skip_turn system tool, authentication enabled, overrides enabled for prompt, first message, language and voice) and spike scripts. A textOnly run checks turn-taking logic but not VAD or ASR, so a short real-voice run by a human is also required to test whether the agent answers the expert's own speech. Records latencies and decides how 'speak only when our code says so' works. Findings go to packages/agent/README.md.

Estimate: about 2 h of agent time. Card key: B-elevenlabs-spike.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GET /v1/user and /v1/user/subscription succeed with the key; plan tier, remaining agent minutes and concurrency are recorded, and whether the hackathon Creator code was applied is stated; if fewer than about 60 agent minutes are available or agents are not enabled, this is escalated to Ivan within the first 30 minutes (Discord code) before more cards start
- [ ] #2 The provisioning script creates or updates both agents from JSON config and prints their ids; ids and keys are never committed (ids go to env)
- [ ] #3 In a 60 s textOnly conversation, a stream of contextual updates produces zero agent replies; if the agent does speak, the fallback (turn_timeout, skip_turn prompt rule, orchestrator marker) is implemented and re-tested until it is silent
- [ ] #4 Real-voice test with a human: 60 s of the expert talking and typing without a question open yields zero agent utterances (agent skips its turn); if skip_turn does not hold, the decision to gate the mic and use Scribe v2 Realtime for expert transcripts is made and written down
- [ ] #5 sendUserMessage with an orchestrator marker makes the agent say the given question verbatim; latency from send to first response is recorded over at least 5 tries
- [ ] #6 Whether the SDK can mute the mic, or off-record must end the session and restart it, is answered; likewise whether an empty first message keeps the agent silent, whether webhook tools or MCP are allowed in this workspace and whether the knowledge base accepts a text document are each answered yes or no in the README
- [ ] #7 A signed URL minted with the server key opens a session from a script; the key does not appear in any output
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PR #2 merged: scripts and live findings in apps/api/agent/elevenlabs/README.md. Dev agent apprentice-interviewer-dev exists (id kept out of git). Open: real-voice silence test by a human; agent-minute balance and Creator code (dashboard); Expressive Mode voice choice. Tutor agent moved to TASK-3.13.
<!-- SECTION:NOTES:END -->
