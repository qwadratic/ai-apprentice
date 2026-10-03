# AGENTS.md — AI Apprentice (Hack-Nation 7, Challenge 01)

Instructions for coding agents that do not read CLAUDE.md (Codex and others). CLAUDE.md holds the full background: the challenge brief, the deadlines and the history of decisions.

## Where things are

- Plans (Russian originals): `backlog/docs/plans/` — `doc-2` the joint plan and call transcript, `doc-3` stream A (screen and workspace), `doc-4` stream B (agent, voice and knowledge).
- Tasks: Backlog.md in `backlog/`, one Markdown file per task. Install with `npm i -g backlog.md`.
- Existing code: `mac/` (native macOS companion, Swift, built by CI on macos-15; frozen bonus, not the product) and `sandbox/` (its static demo pages). The product is the web app described in the plans.

## Ownership

- Stream A owns `packages/screen`, `apps/web/features/screen`, `apps/web/features/demo-workspace`, `apps/api/screen`, the repo skeleton and the root lockfile.
- Stream B owns `packages/agent`, `apps/web/features/agent` and the app shell, `apps/api/agent`, `fixtures/agent`.
- The only interface between the streams is the ScreenBridge v1 contract (see the plans). Agree contract changes with the other stream before making them.

## Rules

- Follow `backlog/docs/doc-1 - Parallel-work-rules.md`. In short: create subtasks only under your own stream's parent task; create new top-level tasks only on `main` and push at once; claim a task on `main` (status In Progress, assignee) before branching; one task per branch and per PR; a task is Done only when its PR is merged.
- Repo, code, comments and commit messages in English. The repo is public: no secrets, no keys, no real personal data.
- Ask a human before anything public or irreversible.

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.53.0 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
