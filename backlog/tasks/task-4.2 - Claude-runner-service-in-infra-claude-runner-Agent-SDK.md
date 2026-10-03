---
id: TASK-4.2
title: Claude runner service in infra/claude-runner (Agent SDK)
status: To Do
assignee: []
created_date: '2026-10-03 21:10'
labels:
  - shared
  - infra
milestone: m-0
dependencies:
  - TASK-4.1
parent_task_id: TASK-4
priority: high
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Brief: doc-5, step 2. Standalone service on 127.0.0.1:8787 with bearer RUNNER_TOKEN: GET /health {ok, mode, model, git_sha}, POST /v1/complete and POST /v1/vision (up to 4 base64 images) with an optional JSON Schema for structured output. @anthropic-ai/claude-agent-sdk with tools: [], permissionMode dontAsk, settingSources [], persistSession false, an empty dedicated cwd, maxTurns 3, maxBudgetUsd 0.5, CLAUDE_CODE_DISABLE_AUTO_MEMORY=1; semaphore RUNNER_CONCURRENCY=2 (about 1 GiB per subprocess on a shared 2 vCPU / 4 GB plan), queue of 10 then 429, 60 s timeout with AbortController. Exactly one of CLAUDE_CODE_OAUTH_TOKEN (private development) or ANTHROPIC_API_KEY (anything judges reach) must be set. Optional LLM_BACKEND=messages through @anthropic-ai/sdk once an API key exists (faster for per-frame vision). A's vision adapter and B's agent API call it at RUNNER_URL.

Estimate: about 2 h of agent time. Card key: D-llm-runner.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The doc-5 acceptance commands for /v1/complete and /v1/vision pass (schema-valid JSON, customer_07 and the order number read from the test PNG); p50 of 3 calls each is recorded
- [ ] #2 Sustained test: 1 frame per 2 s for 60 s; p50, p95, peak RSS and failures recorded in infra/README.md; the queue answers 429 instead of growing
- [ ] #3 /health shows mode oauth or apikey; the runner refuses to start with both or neither credential set
- [ ] #4 Failures come back typed (502 with the SDK subtype, 504 on timeout with the subprocess killed), never as an empty success
- [ ] #5 Port 8787 is not reachable from outside; prompts, images and outputs never appear in journald, ~apprentice/.claude or the runner cwd
- [ ] #6 The runner API (routes, shapes, env vars, errors) is documented in infra/README.md for A and B
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Acceptance criteria checked, final summary says what changed and how it was verified
- [ ] #2 Fast checks of the touched package pass; CI is green on the branch head
- [ ] #3 No secrets, keys or real personal data in the diff
<!-- DOD:END -->
