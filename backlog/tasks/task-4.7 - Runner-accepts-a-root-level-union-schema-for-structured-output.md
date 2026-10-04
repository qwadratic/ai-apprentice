---
id: TASK-4.7
title: Runner accepts a root-level union schema for structured output
status: In Progress
assignee:
  - '@apprentice-devops'
created_date: '2026-10-04 02:46'
updated_date: '2026-10-04 02:47'
labels:
  - shared
  - infra
milestone: m-0
dependencies: []
parent_task_id: TASK-4
priority: high
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The real screen smoke on 391f2f8 failed: A's vision call reaches the runner, which answers 502 sdk_error/is_error in about 1.5 s, and the screen module reports runner_unavailable, so no ScreenObservation is ever produced. Direct runner calls on the VM showed why: the Agent SDK structured output rejects a union (oneOf/anyOf) at the root of the JSON schema, and VISION_RESULT_SCHEMA is a root oneOf of four object variants. Each variant alone works, and the same union nested under an object property works. Clients should not need to know this SDK limit, so the runner adapts: a root union schema is wrapped as {result: <schema>} for the SDK and the output is unwrapped before it is returned.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A schema whose root is oneOf, anyOf or allOf is sent to the SDK wrapped as {type: object, required: [result], additionalProperties: false, properties: {result: <schema>}}, and the runner returns the unwrapped value; other schemas are passed through unchanged
- [x] #2 A wrapped call whose output lacks result answers 502 no_structured_output, never an empty success
- [x] #3 Unit tests cover wrap, pass-through and unwrap; the runner typechecks and builds
- [ ] #4 After the deploy, the screen smoke on the VM gets a validated ScreenObservation from the real runner
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. infra/claude-runner/src/schema.ts: wrapRootUnion(schema) -> {schema, wrapped}; unwrapResult(json, wrapped) -> {ok, value}.
2. server.ts: use them where outputFormat is set and where structured_output is returned.
3. test/schema.test.ts (node --test), package.json test script; README runner section notes the adaptation.
4. typecheck, build, tests; PR; after the deploy: runner /health, the API screen smoke and the browser screen run.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Bisect on the VM (direct POST /v1/vision with a synthetic order PNG, 391f2f8 runner): VISION_RESULT_SCHEMA as is (root oneOf) -> 502 sdk_error/is_error in 1.4 s; root oneOf + type object -> 502; root anyOf + type object -> 502; anyOf of two variants with or without root type -> 502; each of the 4 variants alone -> 200 (const, [string, null], minLength 1 and the email attachments array are all accepted); {type: object, required: [result], additionalProperties: false, properties: {result: {oneOf|anyOf: [4 variants]}}} -> 200 with order_view and all four facts in 2.5-3.4 s. Implementation: src/schema.ts (wrapRootUnion, unwrapResult), server.ts uses both; a wrapped output without result -> 502 no_structured_output. npm run typecheck ok, npm run build ok (dist/schema.js), npm test 4/4 pass.
<!-- SECTION:NOTES:END -->
