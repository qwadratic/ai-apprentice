---
id: doc-1
title: Parallel work rules
type: guide
created_date: '2026-10-03 20:48'
---


# Parallel work rules

How two people and any number of agents share one backlog and one repo, in parallel branches, without merge conflicts or duplicate task IDs.

Backlog.md is the task tracker: `backlog/`, one Markdown file per task. Install with `npm i -g backlog.md` (or run `bunx backlog.md`). Agents run `backlog instructions overview` once per conversation (the block at the end of CLAUDE.md says so) and change tasks through the `backlog` CLI, not by hand. `backlog board` or `backlog browser` shows the board; it is generated, never committed.

## 1. Ownership

- Two streams with one owner each. **Stream A**: screen capture, masks, vision, recording, replay, demo workspace. **Stream B**: agent, voice, conversation policy, Work Map, Learn/Review/Teach UX, tutor. Each stream has one parent task. Work both streams must agree on (the ScreenBridge contract) is labelled `shared`.
- Directory ownership (from the plans in `backlog/docs/plans/`):
  - A: `packages/screen`, `apps/web/features/screen`, `apps/web/features/demo-workspace`, `apps/api/screen`, the repo skeleton and the root lockfile.
  - B: `packages/agent`, `apps/web/features/agent` (and the app shell), `apps/api/agent`, `fixtures/agent`.
  - Changing the other stream's files needs its owner's OK. Contract changes are agreed first, then made in one small PR.
- New shared dependencies: tell A, who owns the lockfile.

## 2. Task IDs without collisions

Backlog.md picks the next free number by looking at the working tree, local branches, other worktrees of the same clone and pushed remote branches. It cannot see commits that are not pushed yet on another machine: two people who create a task at the same time on different machines get the same number. Verified with backlog.md 1.53.0. Git does not report this as a conflict (the file names differ), so:

1. **Children only by the parent's owner.** Inside a stream create subtasks of your stream's parent: `backlog task create "Title" -p TASK-2` gives TASK-2.1, TASK-2.2 and so on. Different parents never collide, so nobody needs to coordinate.
2. **New top-level tasks only on `main`, pushed at once.** `git pull --rebase`, create, commit, `git push`. A rejected push means someone wrote first: `git pull --rebase`, then `backlog doctor`.
3. **Agents in worktrees of one clone are safe.** Backlog.md reserves IDs inside `.git`, which all worktrees share; even uncommitted tasks do not collide.
4. **Safety net.** The `backlog-check` workflow fails on duplicate task IDs. Repair on `main` with `backlog doctor --fix`, which renames one of the duplicates.

## 3. Claim, work, finish

1. **Claim on `main`:** `backlog task edit TASK-2.3 -s "In Progress" -a @name`, commit `backlog: claim TASK-2.3`, push. If the push is rejected, pull with rebase; if the task now has another assignee, pick a different task. Git's fast-forward check is the lock.
2. **Branch from `main` after the claim:** `task-2.3-short-name`. One task per branch and per PR. An agent works in its own worktree.
3. **While working** edit only your own task file (plan, notes, acceptance criteria) and code in your own directories. To say something about somebody else's task, use `backlog task edit TASK-x --comment "..." --comment-author @name` on `main`, or tell its owner.
4. **Done means merged.** The PR that lands the code also sets the task to Done and writes the final summary, so `main` never shows Done for unmerged work.
5. Keep branches short: merge `main` into your branch before opening the PR, merge small finished pieces, never sit on a big branch overnight.

## 4. Why this does not conflict

- One file per task. Status, assignee, priority and order (`ordinal`) live in the task's own front matter, never in a shared list.
- Only the claimer writes a task file while it is In Progress.
- Decisions are files too: `backlog decision create "..."`, one file per decision, instead of a growing shared list.
- If a shared append-only list cannot be avoided, mark it `merge=union` in `.gitattributes`.

## 5. Labels and handy commands

Labels: `stream-a`, `stream-b`, `shared`; area labels `contract`, `screen`, `vision`, `workspace`, `voice`, `policy`, `session`, `workmap`, `ux`, `tutor`, `demo`, `infra`, `pitch`, `mac`. Milestones: `m-0` pitch (Sun 10:00 Vienna), `m-1` submission (Sun 15:00 Vienna).

```bash
backlog task list -s "To Do" -l stream-b --plain      # what can I take
backlog task view TASK-2.3 --plain                    # read one task
backlog task create "Title" -p TASK-2 -l stream-b,voice --ac "..." -m m-0
backlog task edit TASK-2.3 -s "In Progress" -a @ivan  # claim (then commit + push on main)
backlog doctor                                        # duplicate IDs, dependency cycles
```
