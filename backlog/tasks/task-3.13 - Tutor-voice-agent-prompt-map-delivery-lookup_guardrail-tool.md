---
id: TASK-3.13
title: 'Tutor voice agent: prompt, map delivery, lookup_guardrail tool'
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
labels:
  - stream-b
  - tutor
  - voice
milestone: m-0
dependencies:
  - TASK-3.12
  - TASK-3.2
  - TASK-3.3
parent_task_id: TASK-3
priority: high
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The ElevenAgents tutor side. Writes the tutor system prompt in packages/agent/src/prompts (explain as the expert did, ask the new hire to predict the next decision first, never state a rule that is not in the supplied map, no customer ids), the map delivery by contextual update at Teach start, and a lookup_guardrail webhook tool served by apps/api/agent (fallback if webhook tools or MCP are not allowed: upload the confirmed map as a text knowledge-base document, per the spike). Warnings and the replay request reach the agent as sendUserMessage with the orchestrator marker, so the spoken text matches the engine's message.

Estimate: about 1.5 h of agent time. Card key: B-tutor-agent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With a real key, a Teach session receives the confirmed map as a contextual update and the tutor answers a question about a guardrail using the expert's wording
- [ ] #2 lookup_guardrail (or the KB fallback) answers for an existing guardrail and says 'not in the map' for a missing one; the tool is served by apps/api/agent with a test
- [ ] #3 The tutor prompt contains no customer ids or pre-written exception (grep test)
- [ ] #4 A WARN command spoken through the coordinator is audibly the engine's message (verified by transcript comparison)
- [ ] #5 The same flow passes with FakeVoiceAdapter in CI
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
