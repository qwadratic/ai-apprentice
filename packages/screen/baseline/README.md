# Supplied baseline workflow candidates (TASK-2.6)

This module supplies three short baseline workflows for the requested Google app
rehearsals. They are configured guidance, not expert-confirmed knowledge. It does
not contain exceptions, reasons, scripted expert answers or predetermined demo
outcomes. App identity alone does not establish the workflow being performed.

`BaselineProfileSelector.observe()` consumes an accepted observation's id, app and
evidence ids. It only matches trimmed, case-insensitive exact app names: Gmail,
Google Sheets and Google Maps. It never searches visible message text for an app
name or assumes access to another tab's DOM. Two consecutive distinct
observations of the same supported app produce a candidate profile. A switch,
unknown app or ambiguous identifier immediately removes the previous prompt;
unknown resets confirmation. Input activity heartbeats should not be passed to
the selector. Instances are per session; call `reset()` on lifecycle reset and
privacy interruption so resumed work must establish its context again.

`parseBaselinePromptContext()` validates the exact server catalog shape, source,
learned flag, app/profile pair, workflow prose and bounded evidence IDs. It
rejects forged baseline instructions. The live caller must additionally verify
that observation and evidence IDs belong to the current session.

`current()` is an immutable, inspectable snapshot. `baselinePromptContext()`
returns null until a stable candidate exists, then returns its app ID, profile ID,
workflow, scope policy and observation/evidence references. It explicitly marks
`source: supplied_baseline` and `learned: false`. The caller must establish visible
or expert-confirmed workflow scope before treating an action as a deviation.

| App | Profile ID | Supplied ordinary workflow |
| --- | --- | --- |
| Gmail | `baseline.gmail-ticket-reply` | Read the customer email; reply with greeting, billing period, invoice date and the matching PDF; check agreement with the invoice. |
| Google Sheets | `baseline.sheets-quarterly-report` | Select invoices by invoice date for the quarter; calculate billed amount, payments against those invoices and unpaid balance per company, then totals. Balance is billed minus paid. |
| Google Maps | `baseline.maps-business-venue` | Compare business-meeting venues and select one rated at least 4.5. |

## Live integration

The conductor owns one selector per session and feeds accepted visual observations
before preparing questions. Input heartbeats and off-record observations do not
select a profile. It sends the candidate as a separate `baselineContext` field to
`generic_question`; the LLM boundary validates canonical catalog contents and
requires referenced observation IDs to exist in that request. Asset evidence IDs
remain server-side because the question input cannot independently validate them.
Baseline prose is never inserted into the expert transcript or learned process
library.

App/surface changes clear scoped question history, speech candidates and learned
process recognition. Unknown frames immediately suspend the baseline. App changes
and the second confirming frame invalidate older prepared questions even when
screen summaries are identical. Cancellation and generation checks discard late
question, recognition and guardrail responses. Off-record/resume and stage resets
require fresh observations.

The existing `process_match` flow still recognizes learned workflows. Once a
supported baseline app has been observed, Teach uses only the currently recognized
process's rules; missing recognition supplies no unrelated library rules. App
identity is still only a candidate for workflow scope.

Review maps carry server-generated `baselineProvenance`: observation/profile/asset
references and links from actual expert turns to question IDs and their supporting
observations. This optional metadata survives map publication and confirmation.
It remains separate from synthesized learned process IDs and expert-quote-validated
rules; baseline instructions do not become expert testimony.

The authenticated `GET /api/agent/conductor/:id/status` inspection endpoint returns
`status.baseline`, including app/profile IDs, candidate status, evidence and the
reason confirmation is pending or suspended. It uses the same session bearer token
and origin policy as events/cues and does not expose transcript text. This is a
diagnostic endpoint, not a new product screen.

`MapRegistry` currently keeps confirmed maps in API process memory. They do not
survive an API restart. The current `mapFrom: null` lookup can select the latest
map. This module does not change storage or finish TASK-3.48 conversation history.

## Verification and real rehearsal

Run `node --test packages/screen/baseline/profiles.test.ts`; it is also included in
`npm run test:screen`. These tests cover switching, unknown/ambiguous frames,
duplicates, alternating apps, scope caution, provenance bounds and immutability.
`apps/api/screen/baseline-live.test.ts` also exercises conductor-to-question
preparation for all three apps, context clearing, late-result rejection and Review
provenance. HTTP route tests cover authenticated inspection. These are synthetic
checks; they do not establish recognition quality on real Google windows or the
quality of live provider-generated questions.

For the real rehearsal, the team should manually share Google windows with the
normal masks. Do not create substitute Google interfaces. Establish the intended
workflow, perform ordinary work, make a visible choice and pause. Confirm the
selected candidate, then verify that a relevant question asks for the reason
without supplying an answer. Give the explanation and its conditions in your own
words, confirm/correct it in Review, and inspect the associated profile/process
and screen evidence. Switch between Gmail, Sheets, Maps and an unrelated app;
verify that unrelated prompts disappear during uncertain transitions. Test an
unknown or masked frame, off-record/resume, and a later case in the same confirmed
workflow. Do not claim to block Gmail Send or Sheets autosave. Avoid an API deploy
between Review and Teach while relying on in-memory maps.
