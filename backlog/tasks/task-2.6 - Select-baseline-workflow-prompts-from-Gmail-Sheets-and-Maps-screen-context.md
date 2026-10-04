---
id: TASK-2.6
title: 'Select baseline workflow prompts from Gmail, Sheets and Maps screen context'
status: To Do
assignee:
  - '@kigulx'
created_date: '2026-10-04 06:39'
labels:
  - stream-a
  - shared
  - vision
  - policy
dependencies:
  - TASK-3.52
references:
  - >-
    backlog/tasks/task-3.53 -
    Demo-pace-and-the-process-library-in-the-conductor.md
parent_task_id: TASK-2
priority: high
ordinal: 77000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Kirill requests automatic baseline prompt selection while Clipa watches real Gmail, Google Sheets and Google Maps. The observer needs to know the ordinary workflow before any exception is learned. Do not embed scenario twists, reasons or expected expert answers. This is distinct from TASK-3.53, which recognises already learned processes; integrate with that work instead of building a competing selector. Track under stream A to reserve IDs without collisions; agent integration is shared with B.

Baseline Gmail: Clipa observes customer ticket handling: read the customer email, prepare a reply with a greeting, billing period, invoice date, and the corresponding PDF invoice attached; reply data agrees with the invoice.
Baseline Sheets: Clipa observes quarterly reporting: select client invoices by invoice date for the target quarter; calculate billed amount, received payments against those invoices and unpaid balance per company, then totals; unpaid balance equals billed amount minus payments.
Baseline Maps: Clipa observes business-meeting venue selection: compare places in Google Maps and select a venue with rating at least 4.5.
Common behaviour: notice a visible deviation from the applicable baseline, ask why at a suitable pause, listen and clarify scope, then pass the expert explanation and evidence into the existing Review/knowledge flow. The baseline is not a prelearned exception or an expert-confirmed learned fact.

Use only available screen evidence or already authorised metadata. Never require page DOM access or assume the shared browser address bar is visible. Unknown or ambiguous surfaces must not inherit an unrelated prompt. A profile identifies this demo workflow; recognising Gmail alone does not prove every email is an invoice task. Keep baseline profiles and learned knowledge distinct and correctly scoped.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Real screen observations distinguish Gmail, Google Sheets, Google Maps and unknown; the selected app/profile is inspectable and a single ambiguous frame does not cause unstable switching.
- [ ] #2 Each supported app loads only its specified short baseline workflow; no scripted exceptions, expert explanations or expected demo outcomes are embedded.
- [ ] #3 The selected baseline reaches the live question generation context before judging deviations, and is refreshed or cleared when the app changes; unknown surfaces cannot retain an unrelated baseline.
- [ ] #4 The selector integrates with TASK-3.53 learned-process recognition without replacing its work or mixing rules from different processes; app identity and workflow identity remain distinguishable.
- [ ] #5 Deviation questions feed the existing explanation, Review and knowledge flow with process/profile identity and evidence; documentation states whether storage survives an API restart rather than implying persistence.
- [ ] #6 Focused checks cover profile switching, unknown/ambiguous screens and context isolation; provide manual real-Google rehearsal steps without creating a fake Gmail, Sheets or Maps interface.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
