---
id: TASK-3.2
title: 'ElevenLabs integration spike: key, credits, agent config, silence behaviour'
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 21:10'
updated_date: '2026-10-05 08:58'
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
- [x] #4 Real-voice test with a human: 60 s of the expert talking and typing without a question open yields zero agent utterances (agent skips its turn); if skip_turn does not hold, the decision to gate the mic and use Scribe v2 Realtime for expert transcripts is made and written down
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
PR #2 merged. Live voice check by Ivan on the deployed lab page (conversations conv_0001m41xyk8rec8tpdy03gc9rrhy and conv_2901m41y0v8pe86sw6z6z7xt83wm, 3 Oct ~22:26 UTC): two spoken Russian utterances got skip_turn and silence; Ask now was spoken verbatim about 2 s after the click; speech after the question got no reply. Real-voice silence: passed (small sample). Open: agent-minute balance and Creator code (postponed by Ivan); Expressive Mode voice choice. Tutor agent moved to TASK-3.13.

Docs-cleanup audit (2026-10-05), per the finalization guide's evidence rule (no AC checked from code presence or grep alone): AC1 was escalated/postponed by Ivan per the existing implementation notes, never resolved. AC2 and AC7 describe the provisioning script and the signed-URL route, both plausible from the architecture docs but not re-verified here by a scripted test. AC3 (a pure textOnly silence run) is not separately recorded; only the real-voice variant (AC4) has a recorded result. AC5's verbatim-speaking claim has one recorded data point (about 2 s) but not the 5 tries the AC asks for. AC6's yes/no answers are not written down in packages/agent/README.md, which has since become the brain-architecture doc; the MCP answer (disabled) surfaces instead in TASK-3.13's comments. Leaving all six unchecked.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ElevenLabs is live: interviewer and tutor agents (eleven_v4_turbo; voices Sarah and Alice; concurrency and daily limits set), signed URLs with SIGNED_URL_REQUIRE_SESSION=1, [ASK] protocol with skip_turn. Latest live prompts (4 Oct 06:15 UTC): demo pace, one-sentence replies, the app asks; greetings 'Hi, I am Clipa.'. Repo config still to sync: TASK-3.39.
<!-- SECTION:FINAL_SUMMARY:END -->
