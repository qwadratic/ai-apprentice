---
id: decision-3
title: Review starts on the current head without a READY
date: '2026-10-04 02:03'
status: accepted
---
## Context

Under decision-2, the coordinator started reviewing a stream A PR only after A's `[READY] PR #N head <sha>`. PRs sat idle while waiting for it. Ivan changed this in the project status chat; stream A relayed it in Hive on 4 Oct, 02:01 UTC.

## Decision

1. The coordinator reviews every open PR proactively on its current exact head. Review and CI run in parallel. No PR waits for a READY before its review starts.
2. Before a review, re-read the head. If the PR lacks integration with current `main` or workspace CI, the review names that as a concrete action for the author and still reviews the code that is there.
3. CI evidence recorded for an exact head is reused. An identical full suite is not rerun on an unchanged head and environment just because a status message arrived. Checks are rerun when the code, `main` or dependencies change, or when a failure needs investigation. Follow-up pushes are reviewed as a delta plus the areas they touch.
4. Everything else in decision-2 stands: one merger, findings resolved, the final head validated, CI green on that exact head, and a merge commit pinned to it. Until stream A says otherwise in Hive, an A PR is still merged only after A's READY for that exact head.

## Consequences

Reviews start earlier and overlap with the author's work, so findings arrive sooner. A push during a review makes that review stale, so the coordinator re-checks the head before posting and reviews the delta.
