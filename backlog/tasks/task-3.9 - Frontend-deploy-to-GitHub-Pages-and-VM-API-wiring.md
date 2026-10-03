---
id: TASK-3.9
title: Frontend deploy to GitHub Pages and VM API wiring
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - stream-b
  - infra
  - ux
milestone: m-0
dependencies:
  - TASK-3.8
  - TASK-4.1
parent_task_id: TASK-3
priority: high
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deploys the web app from main to GitHub Pages (no extra account; Vercel is the alternative if Ivan prefers) with hash routing, VITE_API_BASE_URL pointing to the exe.dev API, and a CI step that fails if a key pattern appears in the built bundle. Needs A's skeleton (apps/web, root build config and lockfile): do not edit those files, ask A or send a PR to A's files with A's approval. The workflow file lives in .github/workflows/deploy-web.yml. The page needs a secure context for getDisplayMedia and the microphone, which Pages and exe.xyz both provide.

Estimate: about 1 h of agent time. Card key: B-frontend-deploy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A public URL serves the app and calls GET /health on the VM without CORS errors, in a second browser profile with no login
- [ ] #2 A push to main redeploys the site; the workflow does not need secrets other than the public API base URL
- [ ] #3 CI greps the production bundle for ELEVENLABS, sk-ant and api-key patterns and fails on a match
- [ ] #4 The microphone and screen-share permission prompts appear on the deployed URL
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
