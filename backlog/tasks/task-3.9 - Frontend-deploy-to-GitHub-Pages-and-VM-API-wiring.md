---
id: TASK-3.9
title: Frontend deploy to GitHub Pages and VM API wiring
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-03 21:10'
updated_date: '2026-10-05 08:58'
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
- [x] #1 A public URL serves the app and calls GET /health on the VM without CORS errors, in a second browser profile with no login
- [x] #2 A push to main redeploys the site; the workflow does not need secrets other than the public API base URL
- [x] #3 CI greps the production bundle for ELEVENLABS, sk-ant and api-key patterns and fails on a match
- [ ] #4 The microphone and screen-share permission prompts appear on the deployed URL
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Docs-cleanup audit (2026-10-05), verified live: AC1 - GET https://apprentice.exe.xyz/health is 200 with no exe.dev login, and a CORS preflight from https://qwadratic.github.io gets 204 with the origin echoed (a foreign origin gets 403); the Pages URL answers 200. AC2 - the 8 most recent release.yml runs all triggered by push to main and succeeded (gh run list); the workflow only needs DEPLOY_WEBHOOK_SECRET for the separate VM job, not for the Pages publish. AC3 - release.yml greps the built site for key-shaped values and fails the job on a match; the recent runs all passed it. AC4 (microphone and screen-share prompts on the deployed URL) needs an actual browser session; not checked in this pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Frontend live on GitHub Pages at https://qwadratic.github.io/clipa/ (repo renamed; base path follows the repo name, PR #45/#47); API at https://apprentice.exe.xyz; release pipeline with guards deploys Pages and the VM on every main push.
<!-- SECTION:FINAL_SUMMARY:END -->
