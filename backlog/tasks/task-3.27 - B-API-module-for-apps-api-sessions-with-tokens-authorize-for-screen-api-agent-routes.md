---
id: TASK-3.27
title: >-
  B API module for apps/api: sessions with tokens, authorize() for /screen,
  /api/agent routes
status: Done
assignee:
  - '@qwadratic'
created_date: '2026-10-04 00:55'
updated_date: '2026-10-04 01:15'
labels:
  - stream-b
  - api
dependencies: []
parent_task_id: TASK-3
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Stream A asked in Hive (4 Oct 00:41) for B's auth/mount/session implementation so the real capture can reach the API. apps/api/agent/index.ts exports mount(app) (and agentModule) for A's createApi registry and authorize(request, sessionId|null) for A's screen module (doc-9 4.1-4.2): POST /api/agent/sessions returns 201 {sessionId, token, issuedAtMs, serverNowMs} (32 random bytes, only the hash stored, origin-checked, per-IP rate-limited; the browser picks sessionEpochMs at the start click); GET /api/agent/elevenlabs/signed-url (server key, never logged); POST /api/agent/sessions/:id/events and /finish ported from infra/placeholder-api with the same limits, plus rotation and the API_TOKEN admin routes. No global API token in the browser.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 mount(app) registers the routes on A's Express createApi; apps/api tests cover token issue, authorize with and without sessionId, wrong token 401/403, origin 403, size 413, rate limit 429
- [x] #2 authorize() works as the screen module's dependency (doc-9 4.2) and is exported with a typed signature
- [x] #3 The routes match the placeholder's behaviour so the lab can switch to /api/agent; no secret or signed URL is logged
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
PR #19 merged (67c6c0b): apps/api/agent with mount/agentModule, authorize(request, sessionId|null), POST /api/agent/sessions {sessionId, token, issuedAtMs, serverNowMs}, signed URL, events/finish, rotation and admin routes; env-configurable limits. Opus review FAIL (4 must-fix) -> fixed -> PASS; verified end to end with A's mountScreen (202 own session, 403 other, 401 no token). Not yet live: the VM still serves the placeholder (TASK-4.5).
<!-- SECTION:FINAL_SUMMARY:END -->
