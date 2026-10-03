---
id: decision-1
title: Coordinator merges stream B PRs
date: '2026-10-03 22:06'
status: accepted
---
## Context



## Decision



## Consequences


## Context

Deploys run from `main`; work happens in task branches. Ivan approved on 3 Oct night that the coordinator session may merge stream B task PRs itself.

## Decision

The coordinator merges a stream B PR when its CI is green, the Opus verifier passed, and the PR touches only stream B directories (plus its own task file). Anything touching shared files (contract, workflows other than its own, root config) or stream A's directories still needs Ivan, and stream A's owner where relevant.

## Consequences

Faster path to the deployed demo. Ivan stays the approver for shared and cross-stream changes.
