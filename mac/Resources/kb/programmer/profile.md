# Maintainer: open-source maintainer reviewing pull requests

## Role
- Maintains a widely used open-source JavaScript library (sandbox repo: openlane/pagekit). Decides which pull requests get merged into `main`.
- Specialty: judging contributions from people the maintainer may never have met. A green tick is an input, not a verdict.
- Experience level: years of reviews. Has merged red PRs on purpose and rejected green PRs on purpose, and can explain both.

## Job duties
- Triage the PR list: read title, author, size, CI status.
- Read the diff, especially tests, `package.json`, lockfiles and `.github/workflows`.
- Decide: merge, ask for changes, close, or wait for a second maintainer.
- Keep `main` releasable. Keep the dependency tree and the CI pipeline trustworthy.

## Tools on screen
- GitHub-style PR page: title, author, branch, description, the Checks box, the Merge pull request button, Request changes.
- Checks: `unit`, `lint` (required), `docs-build`, `e2e-checkout`, `integration-tests`, `license/cla`, `visual-snapshots`. Each is Passing, Failing or Pending.
- Files changed: file list with +/- counts and diff lines. Key files: `package.json`, `pnpm-lock.yaml`, `test/*.test.js`, `.github/workflows/ci.yml`, `__snapshots__/`.

## Typical day
- Morning: open the PR list, clear the easy ones (typos, small fixes with a test).
- Midday: read the larger diffs line by line. Re-run flaky jobs. Reply to contributors.
- Afternoon: backports, release notes, security reports (handled privately).

## What the maintainer knows that the screen does not show
- Which checks are known flaky, which are required, and whether `main` is already red.
- Fork PRs run without repository secrets, so integration tests that need a token fail by design.
- A trivial change such as a typo fix does not need a signed CLA. Anything larger does.
- A snapshot failure is expected when the PR changes the visuals on purpose.
- A new dependency with a `postinstall` script runs code on every install. CI does not test that.
- An edit to `.github/workflows` or a switch to `pull_request_target` runs with secrets and needs a second maintainer.
- Edited tests deserve more suspicion than edited code: weaker assertions or `test.skip` make green meaningless.
- Product direction, scope and release freezes are decided by the maintainers, not by CI.
- An unreadable 3,000-line PR, or an AI-generated one nobody can explain, is rejected even when green.

## Red but merge (reasons the maintainer uses)
- Known flaky e2e test. Failure unrelated to the diff (main already red, external service down).
- Fork PR without secrets: integration tests fail by design.
- Non-required check such as coverage or bundle size.
- Urgent security hotfix. Snapshot intentionally changed. CLA bot on a typo fix.

## Green but reject (reasons the maintainer uses)
- The PR deletes or skips tests, or loosens assertions.
- A new dependency with a postinstall script, or an incompatible licence.
- Edits to `.github/workflows` or use of `pull_request_target`.
- Product direction or scope. A hidden performance or API break. Release freeze.
- A PR too large or too machine-written to review honestly.

## What novices get wrong
- Trust the colour: merge on green, block on red, without reading why.
- Review the source diff and skip the test diff, the lockfile and the workflow files.
- Treat a new dependency as free. Never open its install scripts or licence.
- Re-run a red job until it turns green and never ask why it was red.
- Accept pressure ("please merge today") as a reason.

## Background (real stories, not on screen; use only to explain why caution is normal)
- xz-utils, 2024: a maintainer account that had earned trust over about two years shipped a backdoor in xz 5.6.0 and 5.6.1. The payload was hidden in binary test files and enabled by build steps present in release tarballs. Andres Freund found it while investigating SSH logins that were about half a second slower than expected.
- event-stream, 2018: a new maintainer took over the package and added the dependency flatmap-stream, which carried a payload aimed at a cryptocurrency wallet.
- Hacktoberfest, 2020: a flood of spam pull requests led the organisers to make participation opt-in for repositories.

## How the buddy should behave
- Learn mode: stay quiet while the maintainer reads or types. Ask one short why-question at a pause, about something visible: a red check merged, a green PR rejected.
- Teach mode: before the click on Merge pull request, say the maintainer's reason in the maintainer's own words and ask the novice to predict the decision.
