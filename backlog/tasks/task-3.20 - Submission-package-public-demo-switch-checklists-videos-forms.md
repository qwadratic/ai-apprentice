---
id: TASK-3.20
title: 'Submission package: public demo switch, checklists, videos, forms'
status: To Do
assignee: []
created_date: '2026-10-03 21:11'
labels:
  - stream-b
  - pitch
  - infra
milestone: m-1
dependencies:
  - TASK-3.16
  - TASK-3.18
  - TASK-3.19
parent_task_id: TASK-3
priority: high
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hack-Nation requires five items by Sun 15:00 Vienna: demo video, tech video, team video, public GitHub, deployed clickable demo. Agent part: before judges click, switch the VM LLM runner to ANTHROPIC_API_KEY with PUBLIC_DEMO=1 and unset CLAUDE_CODE_OAUTH_TOKEN, check the ElevenLabs minutes, the daily cap and the kill switch, scan the repo and bundle for secrets, prepare a DRAFT GitHub Release with the CI-built Mac .app described as a frozen bonus, not yet run on a Mac, and write the submission checklist and the copy for both forms. Human part (Ivan and the teammate): record and upload the three videos, publish the release, submit on app.hack-nation.ai and on the backup Google form, add team members, before 15:00 Vienna; target finishing by 13:30. Do not publish, post or submit without @qwadratic's explicit yes.

Estimate: about 2 h of agent time. Card key: B-submission.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The VM runs with PUBLIC_DEMO=1 and an API key; the subscription token is absent from the env
- [ ] #2 A person on a fresh browser profile can open the deployed URL, grant the microphone, and run Teach without a login; the daily cap and kill switch are tested
- [ ] #3 Secret scan of the repo and bundle is clean; README links resolve
- [ ] #4 A draft Release with the Mac .app exists; it is published only after Ivan's yes
- [ ] #5 Human step: entry submitted on app.hack-nation.ai and on the backup form with team members added before 15:00 Vienna; confirmation screenshot saved
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
