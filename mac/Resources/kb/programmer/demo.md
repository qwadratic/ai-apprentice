# Demo script: Maintainer merging pull requests (3 minutes)

Sandbox: `sandbox/programmer.html` (open full screen in a browser, no network needed). Cases are switched with the selector in the top bar, the keys 1-9, or the URL hash: `#list`, `#e1`, `#e2`, `#e3`, `#nv` (and `#x1`..`#x5` for spare rules). Clicking a title in the list opens that PR.

Assumption for the app: Learn mode speaks the rule's `question`, Teach mode speaks the rule's `warning`; `kind` only sorts Work Map entries into judgment calls (`why`) and guardrails.

## Setup (about 15 s)
- Scenario "Maintainer" selected, Learn mode on, mic on, screen share on the browser window, sandbox at `#list`.
- Expert says: "Three pull requests before lunch. I'll think out loud."
- The buddy is silent while the expert reads or talks. It speaks only at a pause, and only about something visible.

## Situation 1: red check, merge anyway (PR #2417, case `#e1`), about 35 s
- On screen: "Fix off-by-one in pagination helper". Checks: unit Passing, lint Passing, docs-build Passing, `e2e-checkout` **Failing** (timeout on `#pay-now`). Merge pull request button.
- Expert does: opens the PR, glances at the red e2e line, opens nothing, moves the mouse to Merge pull request and stops.
- Buddy speaks: at the pause with the cursor on Merge, because rule `flaky-e2e` matches (cue `e2e-checkout` plus `Failing`).
- Exact question: "The e2e check is red, yet you are about to merge. What tells you this failure does not matter?"
- Example expert answer: "That test is flaky, it times out at random and fails on main too. This diff only touches pagination, and the required checks are green. I merge."
- Expert clicks Merge pull request.

## Situation 2: all green, reject (PR #2421, case `#e2`), about 40 s
- On screen: "Add fast cache-key hashing". Every check Passing. Files changed: `package.json`, `pnpm-lock.yaml`, `scripts/fetch-binary.js`, `src/cache.js`. The diff shows `"postinstall": "node scripts/fetch-binary.js"` and a new dependency `fasthash-native`.
- Expert does: scrolls to the `package.json` diff, stops, says "No.", clicks Request changes.
- Buddy speaks: at the pause on the diff, rule `postinstall-dependency` (cue `postinstall` plus `package.json`).
- Exact question: "Everything is green but you are not merging. What in this diff worries you?"
- Example expert answer: "A postinstall script runs arbitrary code on every machine that installs this. CI is green because CI never tests that. A new dependency with an install script needs a reason, a licence check and a second maintainer."

## Situation 3: all green, merge (PR #2425, case `#e3`), about 30 s
- On screen: "Fix ISO week parsing for late December dates". Everything Passing. Description says: "Adds a regression test that fails without the fix." Files: `src/week.js`, `test/week.test.js`.
- Expert does: reads the test diff for a few seconds, then clicks Merge pull request.
- Buddy speaks: at the pause just before the click, rule `green-read-the-diff` (cue `regression test`).
- Exact question: "Everything is green and you merged fast. What did you check besides the green ticks?"
- Example expert answer: "I read the test diff. There is a regression test that fails without the fix, the source change is small, no new dependency, no workflow edit. Green only means the tests that exist still pass."

## New case for the novice: green PR, loosened test (PR #2433, case `#nv`), about 45 s
- Switch the app to Teach mode. The new hire (a judge) sees only the PR list and opens "Speed up price formatter".
- On screen: all checks Passing, "All checks green". Files: `src/format.js` +11 -7, `test/format.test.js` +2 -9. The test diff shows `expect(formatPrice(1299)).toBeTruthy();` replacing `.toBe("12.99 EUR")`, and `test.skip("rounds half up"`.
- Novice does: reads the description, moves to Merge pull request.
- Buddy stops them before the click, rule `weakened-test` (cue `toBeTruthy()` or `test.skip(`).
- Exact warning: "Stop before Merge. The tests were loosened: toBeTruthy() accepts any value and a test is skipped. Green means nothing here. Ask for the originals back."
- Tutor follow-up (from the expert's own words in situations 2 and 3): "In the last PR the maintainer read the test diff first. What is different about the tests in this one?" Novice answers; the tutor confirms and the novice clicks Request changes.

## What goes into the Work Map
- Step 1 Triage the PR list by status and title.
- Step 2 Read the checks. Judgment call: red `e2e-checkout` ignored. Reason in the expert's words: "flaky, fails on main too, unrelated to the diff". Guardrail: only when the required checks are green.
- Step 3 Read the diff, tests first. Judgment call: green PR rejected for a new dependency with a postinstall script. Guardrail: new dependency with an install script needs a reason, licence check and a second maintainer.
- Step 4 Merge only after the test diff is read. Judgment call: green PR merged because the regression test fails without the fix.
- Teach step added from the novice case: loosened or skipped tests block the merge (guardrail `weakened-test`), linked to the screen moments of situations 2 and 3.
- Debrief questions the buddy still owes: which checks are required, what to do about a fork PR with red integration tests, and who is the second maintainer.
