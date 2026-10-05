# Map enrichment: a background job that deepens the Work Map

Reflect builds the Work Map once, from the current session (`map_synthesis`, a short call). `map_enrich` is a second, slower pass that runs **in the background** after that: a model that can *read* everything the expert said and showed, in this session and in earlier ones, and uses it to make the map more precise and to answer some of the open points before Clipa asks them.

It never blocks Reflect, never writes a rule or a reason the expert did not say, and changes the map only while the expert has not confirmed it.

## The flow

```
Show ends ──► map_synthesis (short call) ──► map built ──► startEnrichment()   (RULES.enrichMap)
                                                               │  not awaited; not off the record; own abort handle
                                                               ▼
   hub lane (one job at a time) ─► earlier sessions from disk ─► POST /v1/job on the runner (reads the files, read-only)
                                                               │
                              checked answer (ids, quotes) ◄───┘
                                  │
     expert has not confirmed ────┴──► merge into the map (3-way) ► publish a new version, origin unchanged
     predictions (per open point) ──► Reflect asks a strong one as "Last time you said ... Still true?"
```

- **When it starts.** After the session's own map is built, in the background after Show (`prefetchMap`) or when Reflect builds the map itself (`startReview`). Not for an earlier or demo map (those are not this session's own), not off the record, one job per map, and only if the hub gave the conductor an `enrich` dependency.
- **When its result is dropped.** Off the record (the job is aborted), a new Show, a map built anew (an epoch counter), or the confirmation (the job is aborted: a confirmed map is the expert's). A job that fails, times out or returns something invalid changes nothing; Reflect goes on with the map and the open points as they were. A runner without the job route answers 404, which is such a failure (`map enrich failed`, `error: runner_error`, in the API log).
- **Own lane.** The conductor's `llm` is a queue of short calls the live stages wait on; a job takes minutes, so the hub runs it in a separate single-flight lane. On the runner it holds one `RUNNER_CONCURRENCY` slot while it reads.

## What the model reads

The runner writes these files into a fresh read-only folder (`POST /v1/job`, see `infra/README.md`); the model lists, reads and searches them with its own tools.

| File | Content |
|---|---|
| `sessions/<id>/transcript.tsv` | `time`, `role` (`expert` or `agent`), `text`: one spoken turn per line |
| `sessions/<id>/observations.tsv` | `time`, `observation id`, `app`, `surface`, `summary`, `change`: one screen line each |
| `maps/<id>.json` | a map the expert confirmed in an earlier session |

The current session comes first, then up to `AGENT_ENRICH_SESSIONS` (default 5) earlier sessions of the same persona, newest first. Total at most 1.5 MB (the newest lines of a long session are kept).

Where it comes from, honestly:

- **This session:** the conductor's own memory, full fidelity (every turn, every observation with its id and `change`).
- **Earlier sessions:** what is already on disk, the `{sessionId}.jsonl` logs the web app posts: `USER` and `AGENT` lines are the transcript; the `[screen] ...` context lines the voice agent was given are the screen (app, surface and summary joined in one line, so they are split back apart as well as they can be; **no observation ids and no `change`**). The persona comes from the `[stage] Now in Show|Reflect|Pass it on:` line (Show or Reflect: expert; only Pass it on: new hire); a session with none of them counts as the expert's only if it confirmed a map. A session without a voice connection leaves nothing to read.
- **Confirmed maps:** the registry's newest confirmed maps of other sessions, also those whose log is gone.

Nothing new is written to disk, and nothing from a session that was off the record exists to read (the web app stops uploading and the conductor stops observing).

## What comes back, and what is kept

The schema is fixed on the server (`agent/map-enrich.ts`) and the prompt is generic and hash-pinned (`agent/prompts/map-enrich.ts`, tested like the others: no scenario content). The answer has `map` (`steps`, `guardrails`, `related`), `context` and `predictions`. Every part is checked before anything uses it:

- **Ids stay the input's.** A step, rule, open point, session or observation id the input did not have is dropped, as is the item that carries it; nothing is added to or removed from the map's steps and rules.
- **A quote is the expert's, word for word.** It must be found in an *expert* turn of a transcript that was given (`findQuoteSpan`, the same fold the other tasks use) and at least 12 characters long; the stored quote is the transcript's own span and its session is corrected if the model named the wrong one. An invented quote drops the context fact, the decision or the rule's reason it supported. A prediction keeps its text but loses its quote, and its confidence is capped at 0.5 (a guess), so a confidence above that always comes with the expert's words.
- **Evidence links** (`evidenceIds`) only name observations of this session.
- Items are checked one by one: a broken item is dropped alone, a broken shape drops the answer.

## Merging into the map

`mergeEnrichment(current, base, output)` is a pure three-way merge against `base`, the map the job started from, so what the expert said by voice while the job ran is not undone:

- goal, action, condition, required action: the more precise wording only where the field is still what it was at the start;
- a decision's or a rule's reason and quote: only where there is none; a quote from another session carries `quoteSessionId` and no `quoteAtMs` (its clock is not this session's);
- exceptions and evidence ids are added (exceptions: at most 5, not repeated); `context` (facts the expert stated around the map, each with its quote and session) and `related` (other processes from earlier sessions) are added to the map as optional fields the board can show later.

The teach-back and the open points are left alone. The result is published as a new map version with the origin unchanged (before Reflect has opened, the map is only updated and Reflect publishes it).

## Open points asked as a confirmation

For each open point the job may return a prediction (`gapId`, `likelyAnswer`, `quote`, `sessionId`, `confidence`). When Reflect is about to ask a point whose prediction has `confidence >= RULES.predictConfidence` (0.75), the expert's own words (`quote`) from an **earlier** session, Clipa asks the confirmation instead (`lines.ts` `confirmPrior`):

> Last time you said: "<quote>". Still true?

Everything else stays: the same open point (`questionId` `gap-N`, topic `gap`), the same order and the same limit of three. Any other prediction is asked as the open question, as before. The answer goes through the **existing** voice-edit path (`map_edit`). A bare agreement ("Yes, still true.", `affirmSaid`: at most six words, an agreeing word, no "but" or "not") reaches the edit as `Yes, still true. "<quote>"`, so the edit can keep the confirmed words as the expert's reason; a correction or anything longer goes in exactly as said.

## Switches and limits

| | Where | Default |
|---|---|---|
| `RULES.enrichMap` | `agent/conductor/engine.ts` | `true`; `false` starts nothing and changes nothing |
| `RULES.predictConfidence` | same | `0.75` |
| `AGENT_ENRICH_SESSIONS` | API env | `5` earlier sessions |
| `AGENT_ENRICH_TIMEOUT_MS` | API env | `200000` (the runner's own limit is `RUNNER_JOB_TIMEOUT_MS`, `180000`) |
| `RUNNER_JOB_*` | runner env | see `infra/README.md` |

Privacy: the job reads session content, so the API logs only counts and timings (`map enrich done` / `map enrich failed`); the runner logs only the file count and size and removes the job directory in every case; the files are read-only for the model and, on the Claude engine, confined to the job directory.

## Not done, and not claimed

- The prompt and schema have been exercised against a fake runner and the strict-schema checks, **not yet against a live Codex or Claude run**; the first real job on the VM is the real test (`infra/README.md`, "Rolling out `POST /v1/job`"). Latency on Codex is minutes: Reflect never waits for it, so the result may arrive after the open points have been asked.
- Earlier sessions' screen lines are lossy (see above); if observations should be kept exactly, the conductor would have to store them (a new file in the sessions directory, with the deletion and rotation that go with it). This change adds no stored data.
- The board does not show `context` and `related` yet; they are on the map and in the stored map file.
- The enriched map is not re-read aloud: the teach-back stays the one `map_synthesis` wrote.
