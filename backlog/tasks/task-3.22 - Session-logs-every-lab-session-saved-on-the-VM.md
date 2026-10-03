---
id: TASK-3.22
title: 'Session logs: every lab session saved on the VM'
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-03 22:29'
updated_date: '2026-10-03 22:29'
labels:
  - stream-b
  - session
  - infra
milestone: m-0
dependencies:
  - TASK-3.21
parent_task_id: TASK-3
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every voice session must leave a log we can read afterwards: our own event stream (screen events sent as contextual updates, [ASK] messages, agent and user messages, mode changes, errors) and the ElevenLabs transcript and audio for the conversation. ElevenLabs keeps transcripts and audio, but contextual updates are not in its transcript, and nothing is stored on our side yet. Contract: POST {api}/agent/sessions/{sessionId}/events with {conversationId?, events:[{t, dir, type, text}]} (origin-checked, size and rate limited) appends JSONL under /var/lib/apprentice/sessions/; POST {api}/agent/sessions/{sessionId}/finish with {conversationId} makes the server fetch the ElevenLabs conversation (transcript, metadata, audio) and store it next to the JSONL. Reading is token-protected. Raw material for the Work Map (TASK-3.6, TASK-3.7). Card key: B-session-logs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A session started from the lab page produces /var/lib/apprentice/sessions/<id>.jsonl with every event shown in the page log, including contextual updates
- [ ] #2 Ending the session stores the ElevenLabs transcript and metadata (and audio if available) for its conversationId on the VM
- [ ] #3 Off the record stops event upload; the log records only the switch
- [ ] #4 Foreign origins get 403; bodies over 256 KB get 413; no key or signed URL is ever written to a log
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
