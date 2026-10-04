---
id: doc-11
title: Product overview - how the screen becomes knowledge
type: specification
created_date: '2026-10-04 02:53'
---

# Product overview: how the screen becomes knowledge

This is the one-page answer to "what turns a screen recording into abstractions?" It describes the code on main at 4 Oct, 03:00 UTC, links the sources, and lists the gaps. The contract is TASK-1 / doc-7 (ScreenBridge v1) and `packages/contracts`. The plans are doc-3 (A) and doc-4 (B).

## Four layers

| Layer | What it produces | Where | Owner |
| --- | --- | --- | --- |
| 1. Capture | A frame every 1.5 s from the shared window. Masks are applied in the browser before anything leaves it, giving a processed frame. Typing heartbeats come with `lastInputAtMs`. | `packages/screen/capture` (`ScreenCapture`, `frameIntervalMs` 1500), ScreenPanel | A |
| 2. Vision | Each processed frame goes to the VM. The Claude runner (`/v1/vision`, structured output) turns it into one typed **ScreenObservation**: `order_view` {customerRef, orderId, deliveryAddress, deliveryWindow}, `email_draft` {recipientRef, subject, bodyText, attachments[], previewState} or `ticket` {ticketId, orderId, customerRef, status, summary}, or `incomplete`. Every observation links to frame **Evidence** that can be resolved later. | `apps/api/screen` (`vision-contract.ts`, `VISION_RESULT_SCHEMA`), `infra/claude-runner` | A (schema), B/devops (runner) |
| 3. Changes | The brain compares consecutive observations and names what changed: `attachment_removed`, `attachment_added`, `body_text_added`, recipient or order switches. A change matched with quiet signals (not typing, not talking) becomes a question topic (reason, essentials, guardrail, scope, …), asked at a natural pause. | `packages/agent/src/policy` (topics, policy, quiet) | B |
| 4. Knowledge | The expert's answers and the changes become the **Work Map**: steps tied to screen moments (evidence ids), a rule with its reason in the expert's words, scope, required fields and exceptions. The Map is versioned and confirmed in a teach-back. Teach applies only confirmed versions at the Preview → Send checkpoint. | `packages/agent/src/knowledge`, `review`, `tutor` | B |

Example, customer_07: in layer 2 the email draft loses its image attachment and gains the address and window as text. In layer 3 that is `attachment_removed` plus `body_text_added`, so at the next pause the agent asks: "You removed the template image and typed the details. Why for this customer?" In layer 4 the answer becomes the rule "customer_07 gets the details as text (his phone blocks pictures)". In Teach it fires before Send on T1.

## Inputs we test with

- **Real screen:** a person shares a window with the demo workspace (`apps/web/features/demo-workspace`). This is live in production since 391f2f8. The runner fix in #34 is merged, and the devops smoke test of screen → observation is being rerun.
- **Synthetic screen:** TASK-3.32 shares a tab that shows the simulated desktop with the real workspace in it. A scripted persona works in it like a person, and pre-rendered voice answers the agent. Layers 1–4 all run for real. The page is labelled as a simulation.
- **Sample source:** recorded observations for offline tests and the fallback. They are labelled synthetic in the UI.
- **Real recordings from A:** stream A can add real screen recordings of the workspace from a Mac, for replay and the fallback video (doc-10).

## Known gaps (4 Oct, 03:00 UTC)

- Vision reads only the order and email surfaces in turn, so no ticket observation reaches the Map yet. That is step 3 of order → email → ticket.
- Preview → Send needs a separate acquisition timeout before the 4 s reply deadline (PR #33 review).
- Clip replay of the expert's moment (TASK-2.5) is pending. Frame Evidence resolves today.
