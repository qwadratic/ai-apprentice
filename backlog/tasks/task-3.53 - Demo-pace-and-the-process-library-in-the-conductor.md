---
id: TASK-3.53
title: Demo pace and the process library in the conductor
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 06:07'
updated_date: '2026-10-04 06:58'
labels:
  - stream-b
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan, 4 Oct 06:00-06:20 UTC: the full playtest took about 10 minutes; the demo must fit 2-3 minutes. Clipa should know which learned process it is in and follow that process's strategy, and the demo should cover two business processes. Branch task-3.53-demo-pace-processes, WIP head 5e73786.
- Demo pace: pause 1.8 s, settle 0.5 s, questions at least 15 s apart; Reflect asks at most 2 open points; teach-back at most 60 words; the map is built in the background as soon as Show ends, so Reflect opens with it ready.
- Process library: map_synthesis now returns processes (up to 3), and steps and rules carry a processId. MapRegistry.library() lists every learned process.
- Recognition: a new fast task, process_match, recognises the process at stage start and when the app or surface changes. Clipa then says 'I know this one: <title>. I will only ask about what is different.' at a pause. In Show, the known steps and rules go to generic_question as context; in Pass it on, the recognised process's rules are checked first.
- Live agents were already switched to demo pace on 06:15 UTC: the app asks, Clipa replies in one sentence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Conductor and llm tests updated for processes, processId and the new prompt hashes; root npm run check green
- [x] #2 PR merged and deployed
- [ ] #3 One Show with two processes gives a map with two processes; Pass it on recognises which one is on screen
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [x] #2 Fast checks of the touched package pass; CI is green on the branch head
- [x] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 06:58 UTC: finished by an Opus builder (merge of main, fail-safe background map and recognition, RULES.recognizeProcesses / RULES.mapAfterShow switches, tests for processes, processId, process_match and the new prompt hashes). Root npm run check green; PR #55 CI green on 82ba7e3; merged as 5efbce4 and deployed (VM deployed_sha 5efbce4, Pages deploy.json 5efbce4). Open: AC #3 needs one live Show with two processes. Risk for the pitch: confirmed maps from a rehearsal stay in server memory and feed recognition and Teach rules; restart apprentice-api after the rehearsal.
<!-- SECTION:NOTES:END -->
