---
id: TASK-4.4
title: Switch the Claude runner to ANTHROPIC_API_KEY before any judge-facing URL
status: Done
assignee: []
created_date: '2026-10-03 22:54'
updated_date: '2026-10-05 08:58'
labels:
  - shared
  - infra
milestone: m-0
dependencies:
  - TASK-4.2
parent_task_id: TASK-4
priority: high
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Anthropic's Agent SDK terms require API-key auth for anything third parties use; the runner on the exe.dev VM currently runs on CLAUDE_CODE_OAUTH_TOKEN (private development only). Do this last, right before a judge-facing URL is shared (pitch or submission). Env change only: sudoedit /etc/apprentice/env, set ANTHROPIC_API_KEY, empty CLAUDE_CODE_OAUTH_TOKEN, sudo systemctl restart apprentice-runner. The runner refuses to start if both or neither are set. Key source: a $25 Claude code from Discord or the team's account. See infra/README.md, Manual steps 3. (Created by the VM agent on its branch; moved to main by the coordinator.)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ANTHROPIC_API_KEY is set and CLAUDE_CODE_OAUTH_TOKEN is empty in /etc/apprentice/env (0600); neither appears in git, logs or chat
- [ ] #2 curl -s localhost:8787/health on the VM shows mode apikey
- [ ] #3 infra/check.sh through https://apprentice.exe.xyz passes, including the complete and vision calls
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Docs-cleanup audit (2026-10-05): all three ACs are explicitly not met, by this task's own final summary - Ivan decided (4 Oct) the runner stays on the OAuth subscription token for the hackathon demo, so there was no ANTHROPIC_API_KEY switch. None are expected to pass unless that decision is revisited before a judge-facing use of the runner (10 Oct finals).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Not needed: Ivan decided on 4 Oct 02:00 that the hackathon demo is not production, so the Claude runner stays on the team's OAuth subscription token. No ANTHROPIC_API_KEY switch.
<!-- SECTION:FINAL_SUMMARY:END -->
