# Demo script: Accounts payable clerk, the brief's running example (3 minutes)

Sandbox: `sandbox/accountant.html` (mini ERP, three open invoices). Switch cases with the selector in the top bar, the keys 1-6, or the URL hash: `#list`, `#e1`, `#e2`, `#e3`, `#nv`, `#x1`. Clicking an invoice number in the list opens it. The Cost center field is a real drop-down (4711 Opex, 0400 Capex).

Assumption for the app: Learn mode speaks the rule's `question`, Teach mode speaks the rule's `warning`; `kind` only sorts Work Map entries into judgment calls (`why`) and guardrails.

Facts taken verbatim from the brief: invoice 4471, cost center 4711 (opex) and 0400 (capex), "Equipment over €5,000 is always capex.", "No asset number, no capex booking.", "Unknown supplier: stop and ask the controller.", the supplier that double-bills every December, the Czech subsidiary second approval, the new hire's €7,200 equipment invoice. Invented for the sandbox: supplier names, invoice numbers 4468, 4473, 4479, 4480, the amounts of 4471, 4468, 4473, the asset number the expert types.

## Setup (about 15 s)
- Scenario "Accounts payable clerk" selected, Learn mode on, mic on, screen share on the browser window, sandbox at `#list`.
- The judge plays Sabine. Intro line: "Thursday, 4:10 pm, two days before month-end close, 60 invoices open. I'll do three."

## Situation 1: re-code to capex (invoice 4471, case `#e1`), about 45 s
- On screen: Invoice detail, Supplier Kessler Anlagentechnik GmbH, Category Equipment, Amount 6,480.00 EUR, Cost center 4711 Opex, Asset no. empty.
- Expert does: looks at the amount, opens the Cost center drop-down, switches 4711 to 0400 Capex, types an asset number (for example A-0471).
- Buddy speaks: at the pause after the change, rule `capex-over-5000` (cue `0400` plus `Invoice detail` plus `Equipment`). Rule `no-asset-no-capex` stays for the debrief.
- Exact question: "You moved that one to capex. What made you do that?"
- Example expert answer: "Equipment over €5,000 is always capex."
- Expert clicks Post.

## Situation 2: hold the December supplier (invoice 4468, case `#e2`), about 35 s
- On screen: Supplier Vogel Industrieservice GmbH, Invoice date 12 December, Maintenance service, 1,240.00 EUR, Cost center 4711 Opex.
- Expert does: reads the supplier name, says nothing, moves to Hold and stops.
- Buddy speaks: at the pause, rule `december-duplicate-hold` (cue `Vogel Industrieservice`).
- Exact question: "You are holding this one. What do you know about this supplier that the screen does not show?"
- Example expert answer: "That supplier double-bills every December."
- Expert clicks Hold. Debrief question saved for later, verbatim from the brief: "You held the December invoice. Is that for every supplier, and who decides when to release it?"

## Situation 3: second approval (invoice 4473, case `#e3`), about 35 s
- On screen: Supplier Brno Components s.r.o., Company code CZ01 Czech subsidiary, Components, 3,950.00 EUR.
- Expert does: reads the company code, clicks Send for approval.
- Buddy speaks: at the pause, rule `czech-second-approval` (cue `Czech subsidiary`).
- Exact question: "You sent this one for approval instead of posting it. Why does this invoice need a second pair of eyes?"
- Example expert answer: "It comes from the Czech subsidiary, so it goes for a second approval."

## New case for the novice: €7,200 equipment invoice (invoice 4479, case `#nv`), about 45 s
- Switch to Teach mode. A second judge plays the new hire, Lena, and opens the fresh invoice from `#nv`.
- On screen: Supplier Hartmann Anlagenbau GmbH, Category Equipment, Amount 7,200.00 EUR, Cost center pre-filled 4711 Opex.
- Novice does: reads the description, leaves the opex code in place and reaches for Post.
- Buddy stops them before the click, rule `equipment-not-opex` (cue `Equipment` plus `4711`).
- Exact warning: "Equipment over €5,000 is always capex. If this is over the line, re-code from opex 4711 to capex 0400 before posting."
- Tutor follow-up, replaying the 4471 screen moment: "Sabine would stop here. Why do you think?" Novice answers, switches the code to 0400. The tutor then warns on rule `no-asset-no-capex`: "No asset number, no capex booking. Fill in the asset number before you post to 0400." The novice enters an asset number and posts.
- Optional if time allows: `#x1` shows a supplier "NOT IN VENDOR MASTER". Warning: "Unknown supplier. Stop, do not post, and ask the controller."

## What goes into the Work Map
Seven steps, three judgment calls, four guardrails, each linked to its screen moment and the expert's words.
- Step 1 Open invoice 4471. Step 2 Check supplier and amount. Step 3 Code to a cost center. Step 4 Enter the asset number. Step 5 Post.
- Step 6 Hold invoice 4468. Step 7 Send invoice 4473 for approval.
- Judgment calls: re-code 4471 from opex 4711 to capex 0400 ("Equipment over €5,000 is always capex."); hold the December supplier ("That supplier double-bills every December."); second approval for the Czech subsidiary.
- Guardrails: no asset number, no capex booking; unknown supplier, stop and ask the controller; hold the December double-biller until released (who releases and for which suppliers comes from the debrief); Czech subsidiary invoices never posted alone.
- Teach-back to confirm with the expert, and the open debrief questions: scope of the December hold, who releases it, other triggers for a second approval.
