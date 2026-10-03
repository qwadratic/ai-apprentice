# Demo script: Support agent deciding refunds and exceptions (3 minutes)

Sandbox: `sandbox/support.html` (helpdesk ticket view with fake customers). Switch cases with the selector in the top bar, the keys 1-6, or the URL hash: `#s1`, `#s2`, `#s3`, `#nv`, `#x1`, `#x2`. All thresholds are labelled example policy values: refund window 30 days, agent refund limit 250 EUR.

Assumption for the app: Learn mode speaks the rule's `question`, Teach mode speaks the rule's `warning`; `kind` only sorts Work Map entries into judgment calls (`why`) and guardrails.

## Setup (about 15 s)
- Scenario "Support agent" selected, Learn mode on, mic on, screen share on the browser window, sandbox at `#s1`.
- The judge plays the agent. Intro line: "Billing queue, three refund tickets. I'll decide each one."

## Situation 1: outside the window, refund anyway (ticket 58231, case `#s1`), about 40 s
- On screen: red banner "Open incident INC-2043: Service outage, EU region". Customer message: the service was down for days, wants money back for the last renewal. Order 10482, 89.00 EUR, 41 days ago. Policy line: "Refund window: closed (41 days, limit 30)".
- Expert does: reads the message, looks at the banner, moves the mouse to Refund and stops.
- Buddy speaks: at the pause, rule `window-closed-incident` (cue `Refund window: closed`).
- Exact question: "The window has closed, yet you refund. What changes the answer for this customer?"
- Example expert answer: "There is an open incident in her region. When our outage hit a customer, the 30-day window does not apply. The refund is on us."
- Expert clicks Refund.

## Situation 2: chargeback already filed, do not refund (ticket 58240, case `#s2`), about 35 s
- On screen: customer demands money back for an order 12 days ago (inside the window). Payment status: "Chargeback filed (dispute DP-77104)". Amount 245.00 EUR.
- Expert does: reads the payment status, does not touch Refund, says "No refund here."
- Buddy speaks: at the pause, rule `chargeback-no-refund` (cue `Chargeback filed`).
- Exact question: "A chargeback is already filed and you are not refunding. What goes wrong if you do?"
- Example expert answer: "The customer would be paid twice and we lose the money twice. I leave a note and let the dispute run."

## Situation 3: Enterprise account, loop in the account manager (ticket 58246, case `#s3`), about 35 s
- On screen: Account tier Enterprise, Account manager P. Lindgren. Extra seat add-on billed twice, 120.00 EUR, 9 days ago.
- Expert does: sees the tier, ignores Refund, clicks Escalate.
- Buddy speaks: at the pause, rule `enterprise-account-manager` (cue `Enterprise`).
- Exact question: "You escalate instead of refunding. Why does this customer go to someone else?"
- Example expert answer: "Enterprise accounts have an account manager who owns the relationship and the contract terms. I loop them in before any refund or exception."

## New case for the novice: threat instead of a reason (ticket 58255, case `#nv`), about 50 s
- Switch to Teach mode. The new hire (a judge) opens the ticket. They saw situation 1 in the Work Map and think "outside the window, refund is fine".
- On screen: no incident banner ("Incidents: none"), Standard tier. Order 10459, 89.00 EUR, 38 days ago. Policy line: "Refund window: closed (38 days, limit 30)". Message: "Refund my order now or I will post a public review and warn everyone not to buy from you."
- Novice does: moves to the Refund button.
- Buddy stops them before the click, rules `window-closed-incident` and `review-threat-not-reason` (cues `Refund window: closed`, `public review`).
- Exact warning: "A threatened public review is not a reason to refund by itself. Decide by policy and facts, not by pressure."
- Tutor follow-up, replaying the situation 1 moment: "The expert refunded 41 days after the order. What was the one thing different there?" Novice: "An open incident." Tutor: "Is there one here?" Novice checks the page, answers no, replies without refunding or clicks Escalate.
- Optional spare cases: `#x1` customer asks to refund to "a different card", warning "Never refund to a different card or account than the original payment." `#x2` refund 480.00 EUR over the example agent limit, warning "Over the example agent refund limit of 250 EUR. Do not press Refund. Escalate for a second approver."

## What goes into the Work Map
- Step 1 Read the ticket and the message. Step 2 Check the order history and the refund window. Step 3 Check the payment status and the incident banner. Step 4 Check the account tier. Step 5 Decide: Refund, Escalate, or reply without refunding. Step 6 Leave a note.
- Judgment calls: refund outside the 30-day window while an incident is open (expert's words: "when our outage hit a customer, the window does not apply"); escalate an Enterprise account instead of refunding.
- Guardrails: chargeback already filed means no refund; a threatened public review is not a reason by itself; never refund to a different card or account (seed); over the agent limit needs a second approver (seed).
- Teach-back and debrief questions still owed: which incidents count as "hit this customer" and for how long, when a goodwill refund is acceptable and who can grant it.
