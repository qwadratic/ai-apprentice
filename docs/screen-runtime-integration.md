# Real screen integration slice

This local integration combines the accepted ScreenBridge contract, processed capture, the polled vision transport, and the B session API. It does not deploy or publish the product shell.

## Run locally

Use Node 22.22 or newer and npm 10. Install the root lockfile with `npm ci`, then build contracts with `npm run build --workspace @apprentice/contracts`.

The API requires absolute `DATABASE_PATH` and `MEDIA_DIR`, an existing parent directory for the database, a writable `SESSIONS_DIR`, and exact comma-separated `ALLOWED_ORIGINS`. For the default web dev server, allow `http://127.0.0.1:5173`. Start `npm run dev:api` and `npm run dev:web` in separate terminals. Keep the API bound to `HOST=127.0.0.1` for a local test.

Supply `RUNNER_URL` and `RUNNER_TOKEN` only to the API process through the approved server environment. Never put either value in Vite configuration, browser fields, URLs, screenshots, or logs. Without them the upload produces `runner_unconfigured`; it cannot produce a successful observation.

Open `http://127.0.0.1:5173/screen-test.html` in Chrome. The test page uses `http://127.0.0.1:8000` as the API origin by default.

1. Open the synthetic order link in another tab or window. It contains no real customer data.
2. Prepare a B session. This calls the real `/api/agent/sessions` route before the screen picker gesture.
3. Choose the synthetic order tab/window. The first frame stays in local mask review.
4. Mask the private marker at the bottom. Confirm masks and share.
5. Wait for a validated observation. Upload acceptance (`202`) alone is not vision success.
6. Load processed Evidence and inspect the masked region. Pause sharing and verify that no delayed observation appears. Resume, then stop.

The fixture is synthetic input, not a mock model. Runtime code contains no generated observation fallback. Unit tests that inject a model response remain explicitly mock verification.

## Boundaries

- B owns browser session IDs, epochs, bearer tokens, and the agent module. All screen routes authorize against that same B session.
- The ScreenSessionHub credential stays server-side; the composition adapter removes it from the start response and translates only after B authorization.
- Mutating screen routes require an exact configured Origin. Authorized GET requests may omit Origin for same-origin fetch; a supplied foreign Origin is rejected.
- Only processed capture frames enter the HTTP upload path. Vision outputs are parsed through the canonical contracts and associated with file-backed Evidence and SQLite metadata.
- The screen panel uses the runtime's separate panel controller so its mask confirmation cannot clear an app-owned off-record pause.
- The product shell, workspace checkpoint registry, automatic voice question, answer capture, and saved rule are subsequent integration checks. This page does not claim to prove them.

## Current evidence

The local HTTP check confirmed `health.modules = [agent, screen]`, B session creation `201`, screen start `201`, off-record pause `200`, and stop `200`. The start response did not expose the internal ScreenSessionHub token.

An explicit synthetic PNG error-path check confirmed upload `202`, zero observations, and `error: runner_unconfigured`. This verifies honest failure with missing configuration, not a real vision pass.

B confirmed the all-routes agent-token authorization model. B also confirmed that no SSH/tunnel path is currently available and the VM agent has stopped. The supported real-run path is a reviewed merge/deployment together with the TASK-4.5 switch to the composed API; localhost browser use against that VM also needs an approved Origin. Direct SSH from the coordinator Mac was denied. The available in-app browser did not open localhost and an automated Chrome surface was unavailable, so the OS picker and real browser-to-runner pass remain unverified until completed manually or through an approved browser surface.

The integration passed root `npm run check` on Node 22: strict type checking, package and screen tests, and the production build including both test pages. One optional real-browser capture test was skipped. The bridge integration test uses actual screen hub/handlers/service and an explicitly mocked VisionRunner; it does not prove live vision.
