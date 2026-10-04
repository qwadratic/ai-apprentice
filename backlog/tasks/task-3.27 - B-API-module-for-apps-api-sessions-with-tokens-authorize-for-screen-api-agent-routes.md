---
id: TASK-3.27
title: >-
  B API module for apps/api: sessions with tokens, authorize() for /screen,
  /api/agent routes
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-04 00:55'
labels:
  - stream-b
  - api
dependencies: []
parent_task_id: TASK-3
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Stream A asked in Hive (4 Oct 00:41) for B's auth/mount/session implementation so the real capture can reach the API. apps/api/agent/index.ts exports mount(app) for A's createApi registry and authorize(request, sessionId|null) for A's screen module (doc-9 4.1-4.2): POST /api/agent/sessions returns {sessionId, sessionEpochMs, token} (32 random bytes, only the hash stored, origin-checked, rate-limited); GET /api/agent/elevenlabs/signed-url (server key, never logged); POST /api/agent/sessions/:id/events and /finish ported from infra/placeholder-api with the same limits. No global API token in the browser.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 mount(app) registers the routes on A's Express createApi; apps/api tests cover token issue, authorize with and without sessionId, wrong token 401/403, origin 403, size 413, rate limit 429
- [ ] #2 authorize() works as the screen module's dependency (doc-9 4.2) and is exported with a typed signature
- [ ] #3 The routes match the placeholder's behaviour so the lab can switch to /api/agent; no secret or signed URL is logged
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
