---
id: TASK-3.39
title: Record the live ElevenLabs agent settings and prompts in the repo
status: To Do
assignee: []
created_date: '2026-10-04 04:15'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: medium
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
apps/api/agent/elevenlabs/agents.config.json is out of sync with the live agents. Live state on 4 Oct, 04:10 UTC: the interviewer and the tutor both run eleven_v4_turbo; the interviewer voice is Sarah, the tutor voice is Alice; first_message greetings are on; concurrency is 2, with 30 conversations a day for the interviewer and 20 for the tutor, no bursting; temperature 0.3; the tutor has max 420 s. Both prompts are generic, with no customer_07 examples. The [ASK] text is translated into the language of the conversation. Both agents follow the expert's or new hire's language. Copy the prompts in from the live agents (GET /v1/convai/agents/{id}) without any keys.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 agents.config.json and the prompt files match the live agents
- [ ] #2 Provisioning from the repo reproduces the live settings
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
