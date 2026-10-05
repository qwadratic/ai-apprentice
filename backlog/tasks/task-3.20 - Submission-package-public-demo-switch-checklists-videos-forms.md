---
id: TASK-3.20
title: 'Submission package: public demo switch, checklists, videos, forms'
status: Done
assignee: []
created_date: '2026-10-03 21:11'
updated_date: '2026-10-05 08:58'
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
- [x] #3 Secret scan of the repo and bundle is clean; README links resolve
- [ ] #4 A draft Release with the Mac .app exists; it is published only after Ivan's yes
- [ ] #5 Human step: entry submitted on app.hack-nation.ai and on the backup form with team members added before 15:00 Vienna; confirmation screenshot saved
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The entry was submitted. This repo's own structure is the evidence: main is frozen at the submission commit (42b2eec) and release was cut from it for post-submission hardening (this docs-cleanup branch is one such PR). No contest result is known or claimed - finalists are announced 8 Oct per CLAUDE.md. Status corrected from To Do to Done per the coordinator's instruction. AC3 is checked: a repo-wide grep for key-shaped secrets (sk-ant- and sk_ prefixes) across tracked source found none, release.yml's bundle key-scan step has passed on the 8 most recent runs, and README's linked media (docs/media GIFs, apps/web/public/videos/clipa-story.mp4 and clipa-tech.mp4) and the live app at https://qwadratic.github.io/clipa/ all resolve. AC1 is explicitly contradicted by TASK-4.4's final summary: the runner stayed on the OAuth token, no ANTHROPIC_API_KEY switch. AC4: the macOS release (clipa-macos-latest) exists and is published, not a draft (gh release view) - the mechanism changed from a draft gated on Ivan's yes to an automatic publish on every push to main (mac/README.md), so it is left unchecked as not matching the AC's literal wording even though the outcome it wanted (a public release with the .app) is true. AC2 and AC5 describe live-browser and human-submission-form steps with no trace in the repo to verify in this pass.
<!-- SECTION:FINAL_SUMMARY:END -->
