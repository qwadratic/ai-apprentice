---
id: TASK-3.7
title: 'Knowledge store API: SQLite maps, questions, transcripts, redaction'
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
updated_date: '2026-10-04 06:07'
labels:
  - stream-b
  - workmap
  - session
  - infra
milestone: m-0
dependencies: []
parent_task_id: TASK-3
priority: medium
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
apps/api/agent stores sessions, redacted utterances, questions with their decision-log fields, map versions and evidence references in SQLite, exposed as REST (create session, append utterance, get latest and specific mapVersion, confirm/correct, list questions) via mount(app) with CORS from env, and as an HTTP implementation of the KnowledgeStore interface. Local-first: it runs with node on a laptop; the VM check is part of B-integration-rehearsal. Transcripts pass a Redactor (packages/agent/src/privacy) before storage: regex masking of emails, IBANs, cards and phones behind an interface that a Presidio sidecar could replace later; the UI and README state honestly that speech reaches ElevenLabs unmasked and demo data is synthetic. Deleting a session removes its utterances and marks guardrails derived only from it as conflicted with reason 'source deleted'. Use node:sqlite only after checking that the VM's Node supports it without flags; otherwise tell A before adding better-sqlite3 (lockfile).

Estimate: about 1.5 h of agent time. Card key: B-knowledge-store.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After restarting the server the latest confirmed map and all map versions are still served and evidence ids still resolve through resolveEvidence (mocked)
- [ ] #2 Questions are stored with whyNow, pauseMs, spokenAtMs, evidenceIds, decision and reasons, and can be listed per session (proof for the 'at least 3 live questions' count)
- [ ] #3 Redactor tests: emails, IBANs, card numbers and phone numbers in transcripts never reach the database (checked by reading the file)
- [ ] #4 POST confirm with a failing validateMap returns 422 and stores nothing
- [ ] #5 DELETE session removes utterances and marks dependent guardrails conflicted
- [ ] #6 The route list is documented in apps/api/agent/README.md; the API runs locally with `node`
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
4 Oct 06:30 UTC: still relevant. Confirmed maps live only in server memory (MapRegistry in apps/api/agent/conductor/engine.ts). Ivan wants the person to refine the map later in their web account, so maps and processes need to persist.
<!-- SECTION:NOTES:END -->
