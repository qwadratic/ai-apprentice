---
id: TASK-3.24
title: TypeScript everywhere in stream B
status: In Progress
assignee:
  - '@qwadratic'
created_date: '2026-10-03 23:06'
updated_date: '2026-10-03 23:06'
labels:
  - stream-b
  - infra
milestone: m-0
dependencies: []
parent_task_id: TASK-3
priority: high
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ivan's decision (4 Oct ~01:20): no plain JavaScript in our code. Every stream B source file is TypeScript, type-checked with tsc --noEmit in CI. Rules: strict, noUncheckedIndexedAccess, noImplicitOverride, verbatimModuleSyntax, erasableSyntaxOnly (so Node 22 can run .ts directly), explicit .ts import extensions, ESM; no any (unknown plus validators at JSON and network boundaries); no non-null assertions without a comment. Node code runs with node file.ts; browser code is compiled by tsc to plain JS at build time (the built JS is not committed). Package-local package.json and lockfile until stream A's root workspace lands. Scope: packages/agent (typecheck), apps/api/agent/elevenlabs (.mjs -> .ts), apps/web/features/agent/lab (lab.js, clipa.js -> .ts, built in pages.yml), CI typecheck in stream-b-checks. Stream A's .mjs files and infra/ are their owners' call (asked in Hive and of the VM agent). Card key: B-typescript.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No .js, .mjs or .cjs source files remain under packages/agent, apps/api/agent or apps/web/features/agent (built output excluded)
- [ ] #2 tsc --noEmit passes with the strict rules for each of the three areas, and CI runs it
- [ ] #3 ElevenLabs scripts run with node file.ts; the lab page is built by tsc in pages.yml and still passes its Playwright checks
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
