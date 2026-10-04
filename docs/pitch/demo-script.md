# Demo script: the customer_07 journey in the demo workspace

One run through all three stages, **Show → Reflect → Pass it on**, in the demo workspace (order → email → ticket), the way the reference video shows it. This is Option B in `docs/demo-options.md`.

- **The story.** The expert takes the image out of the email for customer_07 and writes the delivery details as text. Clipa asks why once. Reflect turns the answer into one rule with its exception, and the expert confirms it. A new hire then gets a new customer_07 order with the image only, and Clipa warns before Send with the expert's reason.
- **Length.** The raw take runs 3–4 minutes. Vision runs about 11 s behind the screen, so each question, warning and ready line comes 15–20 s after you stop. Cut the waits in editing, never the answers.
- **Data.** Everything is synthetic.
- **People.**
  - Expert: Ivan.
  - New hire: the teammate, or Ivan in a second browser profile.

## Before the take (5 minutes)

**The app**
- Open https://qwadratic.github.io/clipa/ in Chrome, then do a hard reload (Cmd+Shift+R).
- Health check: https://apprentice.exe.xyz/health should show ok.
- **Clear the stored maps, so the run starts with no maps from rehearsals.** Maps survive a restart (`/var/lib/apprentice/maps.json`), so on the VM: `sudo rm -f /var/lib/apprentice/maps.json && sudo systemctl restart apprentice-api` (about 15 s). Skip this if nobody built or confirmed a map since the last clean.
- In the workspace, the **Demo case** menu holds the cases used below: `Practice order · customer_07` (ORD-2041), `New order · customer_07 · attachment` (ORD-2057, image only) and `Order · customer_03` (the allow case).

**Recording**
- Use Cmd+Shift+5, then "Record Entire Screen", then Options, then Microphone: the built-in microphone.
- macOS does not record system audio, so Clipa's voice reaches the recording through the speakers. Use speakers at about 60%, not headphones.
- Close the other tabs, notifications and chat apps.

## How to pace it

- Make the change, then **stop: hands off the keyboard, silent**. Clipa asks at that pause. Do not narrate over it.
- Answer in one or two sentences, then stop again.
- If she stays quiet for more than 25 s, say your reason anyway and carry on. The map is built from what you said too.
- **Mic off** in the header lets you talk to the room without Clipa hearing. Turn it back on before the next step.

## Stage 1: Show (expert), about 1 minute raw

| Step | You do or say | Clipa (expected; her wording varies) |
| --- | --- | --- |
| 1 | Press **Start** in Show and share the screen when she asks (this Chrome tab is enough). Pick `Practice order · customer_07` (ORD-2041). | "Hi, I'm Clipa." Then quiet. |
| 2 | In the email, press **Remove image**. In the message, type `Delivery address: 14 Sample Lane, 1010 Exampletown` and `Delivery window: 2026-10-12 14:00-16:00`. Then hands off the keyboard, silent. | One short why-question about the change, for example: "Why text instead of the image?" |
| 3 | Answer: *"Their phone blocks images. I write the delivery details in the email."* | At most "Got it." Then quiet. |
| 4 | Press **End** on the stage. | The map starts building in the background. |

## Stage 2: Reflect (expert), about 1 minute raw

| Step | You do or say | Clipa (expected) |
| --- | --- | --- |
| 5 | Press **Reflect**. | The map from Show: your words, the rule they give, and the screen moment. |
| 6 | She asks up to three short points, one at a time. Answer each in a sentence, for example: *"Only customer_07."* · *"An image is fine when the details are also in text."* · *"If you can't tell who the customer is, ask before you send."* | No reply of her own after an answer: the map updates, and she asks the next point. |
| 7 | She reads the teach-back, at most 35 words: for whom, what to do, your reason, the exception. **Correct one detail**, for example: *"Both: the address and the delivery window."* | The map changes, and she reads the changed summary again. |
| 8 | *"Yes, that's right."* | The rule is confirmed by the expert, and she points to Pass it on. |

## Stage 3: Pass it on (new hire), about 1 minute raw

Switch to the new hire: the teammate, or the second Chrome profile. They open the same app, press **Pass it on** and share the screen.

| Step | New hire does or says | Clipa (expected) |
| --- | --- | --- |
| 9 | Pass it on opens on `New order · customer_07 · attachment` (ORD-2057, image only); if it opens on the practice order, pick that case in the menu. Type one line in the message, for example `Your order is on its way.`, keep the image, and stop with hands off the keyboard. | One short warning before Send, with Ivan's reason, for example: "Add the delivery details as text. For customer_07, an image alone won't do." |
| 10 | Type the address and the delivery window from the order into the message. Stop. | "That fixes it. Ready for review." |
| 11 | **The allow case.** Pick `Order · customer_03`, keep the image only, type one line, stop. | **Quiet.** The rule is only for customer_07. |
| 12 | Press **End**. End the take here. | |

Do not press **Preview & check** while the conductor leads Pass it on: that check runs in the browser without the confirmed map yet, so it answers "ask before you send". The take ends on "Ready for review".

## Edit to 2–3 minutes

- Keep in this order: the problem card (5 s), the step 2 change and the question, the step 3 answer, the step 5 map, the step 7 correction and the step 8 confirmation, the step 9 warning, the step 10 ready line, the step 11 silence, the closing card.
- Add captions on the edited cuts: "Simulation: synthetic data, a teammate plays the expert" at the start, and "Clipa warns; she never clicks for you" at the warning.
- Use the closing line from `docs/pitch/vision.md`.

## Works on any app (macOS app)

The workspace is the proven path, not a limit. On a Mac, the same journey runs over real apps, for example Gmail and Google Sheets (the earlier script: payment terms changed for one customer, a prepaid licence spread over quarters). Record it, if at all, as a separate optional segment after the main take.

## If something goes wrong

- **No question within 25 s:** make the change again, slower, then stop. If she still says nothing, answer as if asked. The map is built from your words too.
- **Reflect shows "Demo session (synthetic)" with Lumen's payment terms:** Show built no map, so Reflect fell back to the seeded demo map of the real-apps story (`apps/api/agent/conductor/demo-map.ts`). Go back to Show and redo steps 2–4.
- **Clipa asks her own follow-ups or talks around her questions:** the ElevenLabs agents still run the older prompts. Ivan updates them on the VM (`node set-prompt.ts --role interviewer`, then `--role tutor`, from `apps/api/agent/elevenlabs/` with `/etc/apprentice/env` loaded; see the script's header). The script backs up the live prompt first; `--dry` shows only sizes.
- **"Voice is not available, daily call limit":** the limit on the ElevenLabs agent was raised to 1000; end the session and start again.
- **Page error "Cannot reach apprentice.exe.xyz":** a deploy is restarting the API. Wait about 90 s and reload.
- **Clipa answers in the wrong language:** say one sentence in the language you want. She follows.
