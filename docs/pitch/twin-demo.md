# Demo script: the email twin (Northwind Mail) and recognition from earlier sessions

A second demo flow. The expert works in **Northwind Mail**, a realistic mail client that lives in **another browser tab** and is shared like any real app. Clipa reads it through the generic vision path (a frame every 1–2 s, described in words), not through the built-in demo workspace. Because an earlier session of the invoice process is already on file, she **recognises the app and the process** and asks only about what is different.

- **The story.** An invoice email to Lumen Bakery says "Payment terms: Net 14." The expert changes it to Net 30 because Lumen has a signed agreement. Clipa already knows the invoice process (open the draft, check the customer, set the payment terms, send) and its rule (a signed agreement gets Net 30, anything longer needs the finance lead). She says so quietly in the feed and asks only what the earlier session did not cover.
- **Data.** Everything is synthetic: the twin's names, addresses and numbers, and the earlier session.
- **The earlier session is seeded, not recorded.** With `AGENT_SEED_MAPS=1` the server loads one invented confirmed map, "Invoice email: payment terms" (`apps/api/agent/conductor/seed/twin-sessions.json`), in memory only. The feed marks it **Synthetic data**. Say so on camera ("one earlier session seeded for this demo"). The main demo's customer_07 rule is never seeded: it is always learned live, so case (c) is taught from scratch, as in `demo-script.md`.
- **Honesty.** The twin is a plain web page in its own tab. Clipa watches it and speaks up before Send, but she cannot block a click in another tab. Send in the twin is simulated and sends nothing. Never call the recognition live learning: it recognises a process taught earlier.
- **People.** Expert: Ivan. New hire (optional last part): the teammate, or Ivan in a second browser profile.

## Before the take (5 minutes)

**The server needs the seeds, and no real maps**
- Dev rig: `npm run dev` turns `AGENT_SEED_MAPS` on by itself (set `AGENT_SEED_MAPS=0` to turn it off). The API log shows `seeded invented earlier sessions … count 1`.
- The VM (rehearsal only): put `AGENT_SEED_MAPS=1` in `/etc/apprentice/env`, then `sudo rm -f /var/lib/apprentice/maps.json && sudo systemctl restart apprentice-api`. The seeds load only while **no confirmed map exists**, so a map left over from an earlier take hides them. **Remove the line again and restart before any judge-facing run**: production leaves it unset.
- Production config is untouched: the variable is off by default and is documented in `infra/README.md`.

**The tabs**
- Tab 1, the app: the dev URL (`http://127.0.0.1:5173/`) or https://qwadratic.github.io/clipa/. Hard reload.
- Tab 2, the twin: in the app, open the Start panel's **Options and limits** and press **Open the email twin in a new tab**. Or open `…/twin/mail/index.html?case=a` yourself (dev: `http://127.0.0.1:5173/twin/mail/index.html?case=a`).
- Window at 1080p, zoom 100%. The twin uses large type on purpose. Close other tabs, notifications and chat apps.

**The twin's cases** (the **Twin case** menu in the top bar, or `?case=`). Nothing is stored: a reload starts again from the URL.

| Case | `?case=` | The draft |
| --- | --- | --- |
| (a) Invoice · Lumen Bakery | `a` | To `billing@lumen-bakery.example`, subject "Invoice INV-2231", the body ends "Payment terms: Net 14.", invoice PDF attached |
| (b) Invoice · North Pier | `b` | To `billing@north-pier.example`, subject "Invoice INV-2232", Net 14, invoice PDF attached. The case where nothing has to change |
| (c) Delivery update · customer_07 | `c` | To `customer_07`, "Delivery update — ORD-2063", **empty message**, `delivery-summary.png` attached (click its name to see the image: address and window) |
| (d) Blank compose | `d` | Nothing |

## How to pace it

- Make the change, then **stop: hands off the keyboard, silent**. Clipa asks at that pause. Do not narrate over it.
- Vision runs 10–15 s behind the screen: the "Recognised" line and each question come that long after you stop. Cut the waits in editing, never the answers.
- Answer in one or two sentences, then stop again. **Mic off** in the app header lets you talk to the room without Clipa hearing.

## Part 1: Show (expert), about 1–2 minutes raw

| Step | You do or say | Clipa (expected; her wording varies) |
| --- | --- | --- |
| 1 | In tab 1 press **Start** in Show. When she asks to share, pick **the Northwind Mail tab** (Chrome Tab, not the entire screen, not the app tab). Go to tab 2. | "Hi, I'm Clipa." Then quiet. |
| 2 | In the twin open case **(a)** (`?case=a` or the menu). Do nothing for about 15 s: hands off, silent. | **Quiet, but visible in tab 1's live feed:** a thought bubble "This looks like Invoice email: payment terms" and a feed line **Recognised: Invoice email: payment terms (from an earlier session)** with the *Synthetic data* tag. Nothing is spoken. |
| 3 | Select "Net 14" in the last line and type `Net 30`. Say, while you type: *"Lumen has a signed agreement for Net 30, so I change the terms."* Then hands off, silent. | At the pause, **one short question about what is different**, not a repeat of the rule she knows. Expect something like "How do you check Lumen's agreement?" or "Who decides when it is longer than Net 30?" |
| 4 | Answer in a sentence, for example: *"I look the customer up in the agreements list; Lumen is on it. Anything longer than thirty days goes to the finance lead."* | At most "Got it." |
| 5 | Press **Send** in the twin. | The twin shows a **Sent (simulated)** toast and lists the message under Sent. Clipa stays quiet. |
| 6 | **The allow case.** Open case **(b)** (North Pier). Leave Net 14 as it is. Press **Send**. | **Quiet.** The recognised line may appear again for this new draft; there is nothing different to ask about. |

If you end Show (say *"That's it."*), Reflect builds the map from what you did and said: the Net 30 decision for Lumen carries your quote, next to the learned rule.

## Part 2 (optional): a process with no earlier session

Open case **(c)** (empty message, image only) and work it as in the main demo: type the delivery details into the message and keep the image. Nothing is recognised here, because no earlier session covers it: Clipa asks why at the pause, and the rule is learned live. This is the contrast with Part 1.

## Part 3 (optional): Pass it on, a new hire on the twin

The new hire opens the app, presses **Pass it on** and shares the **Northwind Mail** tab.

| Step | New hire does | Clipa (expected) |
| --- | --- | --- |
| 9 | Open case **(c)**: empty message, image only. Hover over **Send** (or press **Preview**) and stop. | One short warning **before Send**, only if Part 2 taught and confirmed that rule: the details belong in the text, with the expert's reason. |
| 10 | Type the address and the window into the message. Stop. | "That fixes it. Ready for review." |
| 11 | Open case **(b)** (Net 14), hover over **Send**, stop. | **Quiet.** The longer-terms rule does not apply to standard Net 14. |

## Recording it without a real screen share

`video/recorder/journey.ts` shows the pattern: a headless browser cannot share a screen, so a script posts the typed `screen_activity` observations the vision step would produce, describing what the twin really shows at that moment. For the twin, read the state from the page itself (`window.northwindTwin.snapshot()` gives the view, the case, To, Subject, the body and the attachments) and post it as the observation's summary and change. Everything else is the product: the page, its session, the conductor, the LLM tasks and the cues (`recognised`, `thought`, `ask`, `warn`).

## If something goes wrong

- **No "Recognised" line after 30 s:**
  - The seeds did not load. The log of the API says `seeded invented earlier sessions` only when the flag is `1` **and** no confirmed map exists; remove `/var/lib/apprentice/maps.json` and restart.
  - Vision described the tab in other words and the match stayed under 0.6 confidence. Move the cursor, change the case once, wait 15 s. A second look at the same app and surface is not matched again until you open another case or another app.
  - The shared surface is the app tab, not the twin: stop sharing and pick the Northwind Mail tab.
- **The line says "Recognised" and Clipa asks the rule's own question:** the question task sees the known process as context, but wording varies. Answer as if asked.
- **Reflect shows "Demo session (synthetic)":** Show built no map of its own; redo part 1.
- **A real map should win:** once you confirm a map in Reflect it is the newest, and the seeds stay behind it; they are never written to the maps file.
