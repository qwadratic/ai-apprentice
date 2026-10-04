# Demo script: the full journey, recorded live

One run through all three stages, **Show → Reflect → Pass it on**, on real Gmail and Google Sheets. Stream A designed the cases (DEMO-REAL-3).

- **Length.** The raw take runs 6–8 minutes, because Clipa needs about 13 s from a pause to a question on the current model runner. Cut it to 2–3 minutes in editing, and remove the waits, not the answers.
- **Data.** Everything is synthetic.
- **People.**
  - Expert: Ivan.
  - New hire: the teammate, or Ivan in a second browser profile.

## Before the take (5 minutes)

**Accounts and data**
- **Gmail:** a demo account with a near-empty inbox. One draft reply:
  - To: `billing@lumen-bakery.example`
  - Subject: `Invoice INV-2207`
  - The body ends with `Payment terms: Net 14.`
- **Google Sheet** "Software budget 2027". Columns: `Item | Annual cost | Q1 | Q2 | Q3 | Q4`. One row: `Design suite licence (prepaid 12 months) | 12,000`, quarters empty.
- **For Pass it on:** a second draft to Lumen, subject `Invoice INV-2231`, also ending with `Net 14`. A third draft to another customer, `billing@north-pier.example`, subject `Invoice INV-2232`, ending with `Net 14`.

**The app**
- Open https://qwadratic.github.io/clipa/ in Chrome, then do a hard reload (Cmd+Shift+R).
- Health check: https://apprentice.exe.xyz/health should show ok.
- **Clean server memory, so the run starts with no maps from rehearsals.** On the VM: `sudo systemctl restart apprentice-api` (about 15 s). Skip this if nobody confirmed a map since the last deploy.

**Recording**
- Use Cmd+Shift+5, then "Record Entire Screen", then Options, then Microphone: the built-in microphone.
- macOS does not record system audio, so Clipa's voice reaches the recording through the speakers. Use speakers at about 60%, not headphones.
- Close the other tabs, notifications and chat apps.

## How to pace it

- After each visible change, **keep talking for about 15 s**: what you are doing and why.
- Then **stop, hands off the keyboard, silent for about 5 s**. Clipa asks within a few seconds.
- If she stays quiet for more than 15 s, carry on. The map is still built from what you said.
- **Mic off** in the header lets you talk to the room without Clipa hearing. Turn it back on before the next step.

## Stage 1: Show (expert), 2–3 minutes raw

| Step | You do or say | Clipa (expected; her wording varies) |
| --- | --- | --- |
| 1 | Press **Start Show** on the rail, share the **entire screen**, then switch to Gmail. | A short greeting. Within ~15 s she knows the screen ("Gmail, compose window…"). |
| 2 | Open the INV-2207 draft and change `Net 14` to `Net 30`. Say: *"I'm replying to Lumen Bakery with their invoice. I'm changing the terms here."* Keep narrating for ~10 s, then stop. | "Why did you change the payment terms for invoice INV-2207 to Net 30?" (Live runs today asked "Why did you choose Net 14 payment terms…" about the earlier frame.) |
| 3 | Answer: *"Lumen has a signed agreement for Net 30. Standard is Net 14, and Net 30 is only for Lumen. Anything longer needs the finance lead."* | One short acknowledgement, maybe one narrow follow-up, for example "Who approves longer terms?" |
| 4 | **Language switch.** Go to the Sheet and type `3,000` into Q1 to Q4. Say in Russian: *"Теперь бюджет. Лицензию на год оплатили сразу, двенадцать тысяч, поэтому делю по кварталам."* Then stop. | She answers in Russian and asks why the spread, for example: "Почему вы разбили сумму по кварталам?" |
| 5 | Answer in Russian: *"Она предоплачена на двенадцать месяцев. Если поставить всё в первый квартал, он выглядит как перерасход. Так только для предоплат больше тысячи евро."* | A short acknowledgement in Russian. |
| 6 | Back to English: *"That's it."* Press **End** on the stage. | The map starts building in the background. |

## Stage 2: Reflect (expert), 1–2 minutes raw

| Step | You do or say | Clipa (expected) |
| --- | --- | --- |
| 7 | Press **Reflect**. | The board opens with the map: two processes ("Invoice email: payment terms", "Prepaid cost: spread by quarter"), steps with screen moments, and rules in your words. |
| 8 | She raises at most two open points. Answer briefly, for example: *"Only Lumen. For anyone else, ask finance first."* | She updates the map and says what changed. |
| 9 | She reads the teach-back, about 60 words. **Correct one detail:** *"Not over a thousand: over five hundred euros."* | She says what changed and reads the changed part again. |
| 10 | *"Yes, that's right."* | The map is confirmed, and she points to Pass it on. |

## Stage 3: Pass it on (new hire), 1–2 minutes raw

Switch to the new hire: the teammate, or the second Chrome profile. They open the same app, press **Pass it on** and share the screen.

| Step | New hire does or says | Clipa (expected) |
| --- | --- | --- |
| 11 | Open the INV-2231 draft to Lumen, leave `Net 14` and move the pointer to **Send**. Stop. | "This is Invoice email. I'll step in if one of the expert's rules applies." Then, before Send, a warning with Ivan's reason: Lumen has a signed agreement for Net 30. |
| 12 | Change it to `Net 30`. *"Fixed."* | Quiet, or a short "Good." |
| 13 | Open INV-2232 to North Pier, leave `Net 14`, move to Send. | **Quiet.** This is the allow case: the rule is only for Lumen. |
| 14 | Press **End**. | The summary: what is mastered and what to practise. |

## Edit to 2–3 minutes

- Keep in this order: the problem card (5 s), the step 2 question and the step 3 answer, the step 4–5 language switch, the step 7 board, the step 9 correction and step 10 confirmation, the step 11 warning, the step 13 silence, the step 14 summary, the closing card.
- Add captions on the edited cuts: "Simulation: synthetic data, a teammate plays the expert" at the start, and "Clipa warns; she never clicks for you" at the warning.
- Use the closing line from `docs/pitch/vision.md`.

## If something goes wrong

- **No question within 20 s:** make the change again, slower, and narrate. If she still says nothing, answer as if asked. The map is built from your words too.
- **"Voice is not available, daily call limit":** the limit on the ElevenLabs agent was raised to 1000; end the session and start again.
- **Page error "Cannot reach apprentice.exe.xyz":** a deploy is restarting the API. Wait about 90 s and reload.
- **Clipa answers in the wrong language:** say one sentence in the language you want. She follows.
