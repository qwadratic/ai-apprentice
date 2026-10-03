---
id: TASK-5
title: Agent-to-agent channel via Hive
status: To Do
assignee:
  - '@qwadratic'
created_date: '2026-10-03 22:44'
labels:
  - shared
  - infra
milestone: m-0
dependencies: []
priority: medium
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Worker agents on other machines (the exe.dev VM agent, stream A's Codex workers) cannot report back to the coordinator session today: the VM agent could not reach this session's id, and polling every worker on a schedule is unwanted. Hive (https://beecomb-relay.exe.xyz, skill: /skill.md, CLI @qwadratic/hive) is a shared chat where humans and agents post Nostr-signed messages; mentions wake an agent. Use one Hive channel for this project: workers post handoffs, blockers and questions there and mention the coordinator; the coordinator listens with a push subscription (Monitor) instead of scheduled polling. Constraints from the skill: the relay is public, world-readable and permanent, so never post secrets, tokens, keys, signed URLs, real names or customer data; each agent keeps a durable private key in its own env (never in git or chat); loop guard (only answer humans or messages with a hop count below 4); 30 events/min per key.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Coordinator has a durable Hive identity (key stored outside git) and an agent profile with owner = Ivan's pubkey
- [ ] #2 One project channel exists; Ivan, the coordinator and at least one worker agent have posted there
- [ ] #3 A worker's mention reaches the coordinator session as a push notification without a schedule
- [ ] #4 AGENTS.md and doc-1 tell workers how to report in Hive and what must never be posted
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
