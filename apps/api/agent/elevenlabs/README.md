# ElevenLabs spike (TASK-3.2)

Node 22 TypeScript scripts (run directly with `node file.ts`, native type stripping; no runtime dependencies, global `fetch` and `WebSocket`) that check the ElevenLabs account, provision the dev interviewer agent and test the "speak only when our code says so" protocol in text-only mode. API shapes and validators live in `types.ts`. `npm ci && npm run typecheck` (TypeScript 7, strict) type-checks them; the package has devDependencies only, so `node file.ts` also works without `npm ci`.

Scripts never print the API key or signed URLs. The agent id is not committed; export it from the `provision.ts` output.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | all scripts | ElevenLabs API key (server side only; never in git, never in the browser). |
| `ELEVENLABS_AGENT_ID_INTERVIEWER` | `signed-url.ts`, `textonly-test.ts` | Agent id printed by `provision.ts`. |
| `PHASE_A_MS` | `textonly-test.ts` | Optional. Length of the silence phase in ms (default 60000; 9000 with `--quick`). |

See `.env.example`.

## Scripts

Run from this directory (every script is also an npm script: `check-account`, `provision`, `provision:dry`, `signed-url`, `textonly-test`).

- `node check-account.ts` : subscription tier, quota, agent list and convai settings (read-only).
- `node provision.ts [--dry]` : idempotently creates or PATCHes the agent named in `agents.config.json` (matched by name) and prints the stored config. `--dry` prints the payload only. A config update costs no conversation minutes.
- `node signed-url.ts` : mints a signed URL and prints only status, protocol, host and path.
- `node textonly-test.ts [--quick]` : live text-only conversation (burns agent minutes while connected, about 75 s for the full run). Phase A: contextual updates every 3 s, expect zero replies. Phase B: one non-`[ASK]` user message, expect silence. Phase C: five `[ASK]` messages, expect the exact question back and measure latency. `--quick` shortens phase A.

## Config notes

- `tts.model_id` stays `eleven_flash_v2` (low latency). Expressive Mode (V3 conversational TTS) is deferred until a human has listened to it; flash keeps latency low.
- `platform_settings.overrides` allows only `conversation.text_only` (used by `textonly-test.ts`). The `prompt`, `first_message`, `language` and `tts.voice_id` overrides are disabled (TASK-3.21 hardening): the signed-URL route is reachable from a public page, and anyone who could mint a signed URL could otherwise run the agent with their own prompt. Everything else (llm, tts model, knowledge base) is not overridable either. **Status: the hardened config is in this file but has not been applied to the live agent yet.** Run `node provision.ts` once and check in the read-back that `overrides` shows `prompt: false`, `first_message: false`.
- `conversation.max_duration_seconds` is set to 600 (the field exists in the ElevenAgents conversation config; the platform default is also 600 s). The read-back of `provision.ts` prints it. The lab page additionally ends the session itself after 10 minutes.
- The tutor agent is not provisioned here. It moves to TASK-3.13 (coordinator decision).
- The browser never sees the API key. The web page asks the API for a signed URL: `GET {api}/agent/elevenlabs/signed-url` returns `{ "signed_url": "wss://..." }`. For now the VM placeholder API serves this route. Treat the signed URL as a secret and never log it.

## Findings (3 Oct 2026, live)

### Account

- Tier `starter`, status active, 90,000 characters (0 used), voice limit 10, no professional voice cloning.
- `has_used_creator_coupon_on_account` is false: the hackathon Creator code has not been applied yet.
- The API exposes no agent-minute balance or concurrency number (not in `/v1/user`, `/v1/user/subscription` or `/v1/convai/settings`). Remaining minutes must be read from the dashboard.
- ElevenAgents works on the starter plan: create, patch, signed URL and conversations all succeeded.
- The account already has 5 unrelated agents. Do not touch them. Our dev agent is `apprentice-interviewer-dev`.
- `GET /v1/convai/settings` returns `can_use_mcp_servers=false`: MCP servers are disabled at workspace level.
- The spike used about 2.5 minutes of live conversation in total. Dev sessions burn agent minutes while connected.

### API payload facts

- Create: `POST /v1/convai/agents/create`. Update: `PATCH /v1/convai/agents/{id}`. List supports `page_size` and `search`. Signed URL: `GET /v1/convai/conversation/get-signed-url?agent_id=...`.
- `skip_turn` must be given as `built_in_tools.skip_turn = {name, description, params: {system_tool_type: "skip_turn"}}`.
- LLM id `claude-sonnet-5-5` is accepted. `turn_timeout: 30` is accepted.
- The server fills `soft_timeout_config.timeout_seconds = -1` (off) and `silence_end_call_timeout = -1`. `turn_model` is `turn_v3`.
- Overrides default to false for `tts.voice_id`, `tts.model_id`, `llm` and `knowledge_base`. A per-session voice would need the `tts.voice_id` override enabled again (currently off).
- TTS in config: `eleven_flash_v2` with voice `21m00Tcm4TlvDq8ikWAM` (Rachel). Accepted by the API, never listened to.

### Protocol events

- Signed URL form: `wss://api.elevenlabs.io/v1/convai/conversation?...`. The global `WebSocket` works with no extra headers.
- Client opens with `{type: "conversation_initiation_client_data", conversation_config_override: {conversation: {text_only: true}}}`.
- Server events seen: `conversation_initiation_metadata` (conversation_id, `agent_output_audio_format` pcm_16000, user input format, persistent session token); `ping` (about every 1.7 s, answer `{type: "pong", event_id}`); `agent_chat_response_part` (`text_response_part` with `type` start/delta/stop, `text`, `event_id`, `response_id`; arrives in text-only mode even though it is not listed in `client_events`); `agent_response` (`agent_response_event.agent_response`).
- Text-only mode produced 0 audio events. `user_transcript`, `vad_score` and `interruption` did not occur in text-only mode.

### Silence results (text-only)

- Empty first message: 0 replies after connect.
- `contextual_update` alone never wakes the LLM: 45 s of updates every 3 s (15 updates) gave 0 agent replies, 0 chat parts, 0 LLM turns, 0 audio. (The script now defaults to 60 s.)
- A non-`[ASK]` `user_message` produced silence. In the quick run the LLM took a turn and returned an empty response (start/stop with empty text, i.e. `skip_turn`); in the full run there was no event at all. Both are silent.

### `[ASK]` protocol

- Prompt rule: speak only when a user message starts with `[ASK]` and then say exactly the text after the marker.
- Result: verbatim 8/8 over two runs (5/5 in the full run, 3/3 in the quick run).
- Latency from send to complete `agent_response`, text-only: 712/653/775/739/665 ms (mean 709) in the full run, 592/648/695 ms in the quick run; about 700 ms overall. Real voice adds TTS first-byte time on top. `haiku-4-5` could be tried if less latency is needed.

### Recommendation: speak only when our code says so

1. Send screen events only as `contextual_update`.
2. Our ASK_NOW policy sends `user_message` with `[ASK] <question>`.
3. Keep `turn_timeout=30`, `turn_eagerness=patient`, soft timeout off and silence end-call off (already in `agents.config.json`).
4. Call `sendUserActivity` repeatedly while the expert types or talks (per the docs, each call blocks agent speech for about 2 s).
5. Only if the human voice test below shows the agent answering the expert, gate the mic (unmute only while an answer is open) and use Scribe v2 Realtime for expert transcripts outside answer windows.
6. Off-record: end the session (guaranteed to stop the channel) and start a new one on resume. Mute-only is an optimisation to test later.

### Acceptance criterion 6, question by question

| Question | Answer |
| --- | --- |
| Does muting the mic keep the session silent, versus ending the session, for off-record? | Untested. Ending the session is the safe default. |
| Does an empty first message keep the agent silent? | Yes. 0 replies after connect. |
| Do webhook tools work? | Untested. |
| Do MCP tools work? | No: MCP is disabled at workspace level (`can_use_mcp_servers=false`). Use a webhook or client tool, or enable MCP in workspace settings. |
| Does a knowledge-base text document work? | Untested. |

### Not tested

Real-voice silence (needs a human with a mic), SDK mic mute vs end session, knowledge-base text document, webhook tools, Expressive Mode (`eleven_v3_conversational`), voice quality of Rachel, TTS latency, overlapping `[ASK]` messages, the tutor agent.

### Manual real-voice silence test (for Ivan)

1. Apply the Creator code and check the dashboard for remaining agent minutes first (the test burns about 2 minutes).
2. `export ELEVENLABS_API_KEY=...` and `export ELEVENLABS_AGENT_ID_INTERVIEWER=...` (id from `node provision.ts`).
3. Start a real voice session (mic on, speaker on) from the web page or the ElevenLabs dashboard widget for `apprentice-interviewer-dev`, using a signed URL, without sending any `[ASK]`.
4. Alongside it, send a `contextual_update` every 3 s using the same message shape as phase A of `textonly-test.ts` (that script uses its own text-only socket, so for a real session send them on the voice socket).
5. For 60 s, talk and type as the expert would: read aloud, think aloud, include several 5-10 s pauses and one 30 s pause.
6. Pass: zero `agent_response` events and zero audible agent speech. Fail: the agent speaks at any point.
7. If it fails, gate the mic (unmute only while an answer is open) and use Scribe v2 Realtime for expert transcripts, as in the recommendation above. Record the result here.

## Open items for Ivan

- Check remaining agent minutes and concurrency in the dashboard and apply the Discord Creator code.
- Run the real-voice silence test above.
- Decide: enable MCP at workspace level, or use webhook/client tools for the tutor's `lookup_guardrail`.
- Listen to Rachel (`21m00Tcm4TlvDq8ikWAM`) and choose the final voice.
