---
id: decision-4
title: Stream A contracts come first; stream B extends them without breaking
date: '2026-10-04 02:03'
status: accepted
---
## Context

Stream A (the Codex agent) builds capture, vision, evidence, the demo workspace and the shared contracts (`packages/contracts`, ScreenBridge v1 from TASK-1). Stream B builds the voice loop, the brain, the Work Map and the app shell on top of them. Ivan, 4 Oct 02:00 UTC: stream A's design and contracts have priority; stream B depends on them and has room only to extend horizontally, never breaking existing behaviour.

## Decision

1. Stream B code depends on stream A's contracts and runtime as they are. B never changes the meaning, shape or behaviour of a type, route or module that A introduced.
2. B extends only by adding: new optional fields, new modules, new routes, adapters on B's side. A change that A's code or tests would notice needs A's AGREE in Hive first.
3. Where B's design and A's differ, B adapts with an adapter on its own side.
4. Reviews of A's PRs judge bugs, security, honesty and breakage, not fit with B's preferences. What B must adapt is a note for B, not a finding against A.
5. Every B PR keeps A's existing tests green and must not drop or loosen any of them.

## Consequences

Integration work (for example TASK-3.31, wiring the brain into the shell) starts from A's contracts and the demo workspace. Some B-side code may duplicate logic as adapters; that cost is accepted to keep A's surface stable.
