# Demo options for the pitch (TASK-3.54)

Pitch: 4 Oct, 08:00 UTC (10:00 Vienna). Each option fits 2–3 minutes and runs the whole journey: **Show → Reflect → Pass it on**. Each has one language switch. All customers, amounts and accounts are synthetic.

Clipa's lines come live from the conductor and the ElevenLabs agents. The Clipa lines below show the expected shape only; nothing about the customer or the rule is pre-written into a prompt.

Roles:

- **Expert:** Ivan.
- **New hire:** the teammate, or Ivan in a second browser window.

## Option A: real apps, Gmail and Google Sheets

This is stream A's DEMO-REAL-3 proposal, cases 1 and 2. It presents best.

- **Needs:** TASK-3.52 (generic vision) and TASK-3.53 (demo pace) deployed, plus one passing dry run.
- **Processes:** an email (payment terms) and a table (a prepaid cost spread across quarters).

### Setup

- **Gmail.** Use a demo account with a near-empty inbox. Prepare one draft:
  - To: `billing@lumen-bakery.example`
  - Subject: `Invoice INV-2207`
  - The body ends with `Payment terms: Net 14.`
- **Google Sheet** "Software budget 2027". Columns: `Item | Annual cost | Q1 | Q2 | Q3 | Q4`. One row: `Design suite licence (prepaid 12 months) | 12,000`, quarters empty.
- **Clipa** on the web, dark theme. Share the **entire screen**. Mask the account avatar and address.

### Script

| Time | Who | Line or action |
| --- | --- | --- |
| 0:00 | Ivan | Starts **Show**. "I'm sending Lumen Bakery their invoice." Changes `Net 14` to `Net 30`. Hands off the keyboard for about 2 s. |
| ~0:15 | Clipa | "You changed the terms to Net 30. What makes Lumen different?" |
| | Ivan | "Lumen has a signed agreement for Net 30. Standard is Net 14, and Net 30 is only for Lumen. Anything longer needs the finance lead." |
| ~0:35 | Ivan | **Language switch.** Switches to the Sheet and speaks Russian: "Теперь бюджет. Лицензию на год оплатили сразу, двенадцать тысяч." Types `3,000` into Q1 to Q4. Pauses. |
| ~0:55 | Clipa | Answers in Russian: "Почему вы разбили сумму по кварталам?" |
| | Ivan | "Она предоплачена на двенадцать месяцев. Если поставить всё в первый квартал, он выглядит как перерасход. Так только для предоплат больше тысячи евро; мелочь идёт сразу в месяц оплаты." |
| ~1:10 | Ivan | Back to English: "That's it." Ends Show. |
| 1:10 | Clipa | **Reflect** opens with the map ready: two processes, "Invoice email: payment terms" and "Prepaid cost: spread by quarter". |
| | Clipa | Asks at most two open points, for example: "Is Net 30 only for Lumen, or for everyone who pays monthly?" |
| | Ivan | "Only Lumen. For anyone else, ask finance first." |
| | Clipa | Reads the teach-back (at most 60 words). |
| | Ivan | **Corrects one detail:** "Not over a thousand: over five hundred euros." |
| | Clipa | Says what changed. |
| | Ivan | Confirms: "Yes, that's right." |
| ~1:50 | New hire | Starts **Pass it on**. |
| | Clipa | "I know this one: Invoice email. I'll only ask about what's different." |
| | New hire | Writes the invoice to Lumen and keeps `Net 14`. Moves to **Send** and pauses. |
| | Clipa | Warns in English: "Before you send: Lumen has a signed agreement for Net 30. Want to see Ivan's moment?" |
| | New hire | Changes it to `Net 30`. No warning now. |
| (optional) | New hire | Invoice to another customer on `Net 14`. Clipa stays quiet: this is the allow test. |
| ~2:40 | Clipa | Summary: what is mastered, what to practise. |

### Why it is strong

- It is the brief's own story: any real workflow, judgment that is written down nowhere, a guardrail.
- The expert explains in Russian and the tutor teaches in English. That is the brief's stretch goal.

### Risks

- **Generic vision is new.** In the dry run, check that Gmail and Sheets each produce a question.
- **Sheets has no Send-like action.** Typing into a cell is a weak pending action, so Pass it on uses the email.

## Option B: the demo workspace (customer_07)

The proven path: doc-10 v1, the order table, then the email, then the ticket. It does not depend on TASK-3.52.

- **Processes:** one process across two surfaces (the order table and the email). The ticket close-out may come out as a second process, but do not promise it.

### Script

| Time | Who | Line or action |
| --- | --- | --- |
| 0:00 | Ivan | Starts **Show** on `ORD-2041` (customer_07). "Order 2041. I copy the delivery address and time into the email as text." Pauses. |
| ~0:15 | Clipa | "Why text here instead of the screenshot?" |
| | Ivan | "customer_07 asked for it. She reads mail on her phone and the images don't load. Only her. The screenshot can stay as an extra." |
| ~0:35 | Ivan | **Language switch** to German or Russian: "Und dann das Ticket: ich schließe es erst nach dem Senden." Clipa follows in that language. |
| ~1:00 | Ivan | Ends Show. |
| 1:00 | Clipa | **Reflect:** the map. Asks, for example: "Is this only for customer_07? What if you don't know the customer?" |
| | Ivan | "Only her. If you can't tell who the customer is, ask before sending." |
| | Clipa | Reads the teach-back. |
| | Ivan | Corrects: "Address **and** delivery time, not just the address." Then confirms. |
| ~1:50 | New hire | **Pass it on:** opens `ORD-2057`, a new customer_07 order with the image only. Clicks **Preview**, then **Send**. |
| | Clipa | The checkpoint warns before Send, quotes Ivan and offers his moment. |
| | New hire | Adds the text. Send is allowed. |
| (optional) | New hire | customer_03 with the image only: allowed, no warning. This is the allow test. |
| ~2:40 | Clipa | Summary. |

## Option C: hybrid

The workspace email from B, plus the Google Sheet from A.

- **Show:** B from 0:00 to 0:35 (the customer_07 email). Then the real Sheet, explained in Russian: A from 0:35 to 1:10.
- **Reflect:** two processes.
- **Pass it on:** B's `ORD-2057` with the proven checkpoint, plus the allow test.
- **Risk:** only the Sheets part needs TASK-3.52. If Sheets yields no question, the demo still holds on the workspace.

## Recommendation

1. **Show A** if TASK-3.52 and TASK-3.53 are deployed by 07:35 UTC and a 3-minute dry run passes: one question on Gmail, one on Sheets, and the warning before Send.
2. **Otherwise show C**, if Sheets gave a question in the dry run.
3. **Otherwise show B.**

Hold to these rules:

- **Freeze `main` from 07:45 UTC until the pitch ends.** Every merge restarts the API.
- **Never deploy between Reflect and Pass it on.** Confirmed maps live in memory.

## Pre-flight, 07:45–07:55 UTC

- **Machine:** Chrome, microphone allowed, speakers at a comfortable volume, notifications off, other tabs closed.
- **Health:** `https://apprentice.exe.xyz/health` shows ok, and `/ops/vm-health` shows `runner: up`.
- **Sharing:** share the **entire screen**. Gmail and Sheets are already open in their own tabs or windows.
- **Pace:** after each action, hands off the keyboard and silent for 2 s. That is the pause Clipa waits for.
- **If Clipa stays quiet for more than 10 s:** say the reason anyway and move on. Reflect still builds the map from what you said.
