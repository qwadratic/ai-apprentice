---
id: TASK-3.21
title: Agent lab page on GitHub Pages
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-03 22:04'
updated_date: '2026-10-03 23:10'
labels:
  - stream-b
  - ux
  - voice
  - demo
milestone: m-0
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Fast clickable preview of stream B before A's skeleton exists: a static page with no build step in apps/web/features/agent/lab/ (Clipa, ElevenAgents session via @elevenlabs/client from a CDN, signed URL from the VM API or a public agent id for testing, playback of the customer_07 mock observations as contextual updates, an Ask now button, off-record that ends the session, a visible event log) plus .github/workflows/pages.yml that publishes it to GitHub Pages from main. Folded into A's app shell later (TASK-3.8, TASK-3.9). Card key: B-agent-lab.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 https://qwadratic.github.io/ai-apprentice/ serves the lab page after a push to main (needs Pages source = GitHub Actions)
- [ ] #2 No key or token is in the page or the repo; the page gets a signed URL from the VM API, or takes ?agent=<public agent id> for testing
- [ ] #3 Clipa reflects the session state: idle, listening, speaking, thinking, off
- [ ] #4 Mock playback sends contextual updates and the log shows every event sent and received
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PR #6 merged (auto-end 10 min, hidden-tab end, audio disclosure, harness label, ?api allowlist, ?agent removed). Live agent patched by the coordinator with Ivan's approval at ~01:35: prompt, first_message, language and voice overrides false, text_only true, max_duration_seconds 600, auth enabled; signed-url still 200 from the Pages origin.
<!-- SECTION:NOTES:END -->
