---
id: decision-2
title: 'Merge queue: the coordinator merges ready PRs from both streams'
date: '2026-10-04 00:09'
status: proposed
---

## Context

Two streams and several agents open PRs; until now only stream B's PRs had a merger (decision-1). Stream A's PRs waited for a human, and nobody owned the review hand-off. Ivan asked on 4 Oct, 00:05 Vienna, that the coordinator session merges PRs from both streams.

## Decision

The coordinator session (stream B's Claude Code coordinator, `@ai-apprentice-coordinator` in Hive) is the single merger for `main`.

1. **Status labels on every open PR** (Ivan, 4 Oct 00:15: progress must be visible on GitHub):
   - `wip`: the author is still working (drafts too);
   - `ready-to-merge`: the author's signal that the PR is done; this label is the merge queue, served oldest first;
   - `in-review`: the coordinator is running the gate below;
   - `changes-requested`: findings are posted on the PR; back to the author;
   - `blocked`: waits on another PR or an external step, named in a PR comment.
   An author who cannot set labels posts `[READY] PR #N head <sha>` in Hive and the coordinator sets `ready-to-merge`. The queue: https://github.com/qwadratic/ai-apprentice/pulls?q=is%3Apr+is%3Aopen+label%3Aready-to-merge
2. **Gate.** CI green on that exact head; an Opus review whose findings are each verified by a second Opus agent; the diff touches only the author's paths from doc-1, or shared paths with an AGREE from both streams in Hive; no secrets or personal data; the backlog check green.
3. **Findings.** Posted as a GitHub review on the PR and mentioned in Hive. The coordinator never pushes to another stream's branch; the author fixes, merges `main` in on conflicts, and re-sends `[READY]` with the new head.
4. **Merge.** A merge commit pinned to the reviewed head sha (no squash, no rebase).
5. **After merge.** The coordinator watches the `release` run. If `main` turns red, it opens a revert PR at once and tells the author.
6. **Events.** The coordinator subscribes to every open PR, so CI, reviews and comments wake it without polling.
7. **People.** Ivan can stop any merge in chat. Freeze (`DEPLOY_FREEZE=1`) still stops releases, not merges.

This extends decision-1. For stream A it takes effect after stream A's AGREE in Hive.

## Consequences

One review path and one merger: no PR waits for a person at night, and every merge has a recorded review. The coordinator becomes a bottleneck; its session must stay subscribed to every open PR and to Hive.
