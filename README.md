# AI Apprentice

A macOS menu-bar companion that watches an expert work, stays quiet while they type, and at natural pauses asks *why* — about the decisions whose reasons are not visible on screen. Later it teaches a novice and stops them before a guardrail is crossed.

Built at the 7th Hack-Nation Global AI Hackathon (Vienna hub, 3–4 October 2026) for Challenge 01, *The AI Apprentice* (ElevenLabs).

- `mac/` — the macOS app (Swift Package, macOS 14+). Build, permissions and configuration: [mac/README.md](mac/README.md).
- `mac/Resources/kb/` — knowledge bases for three roles: open-source maintainer, accounts payable clerk, customer support agent.
- `sandbox/` — static pages the demo runs against, one per role.

The cursor-companion mechanics are inspired by [Clicky](https://github.com/farzaa/clicky) (MIT); see [mac/THIRD_PARTY_NOTICES.md](mac/THIRD_PARTY_NOTICES.md).

License: MIT.

## Web MVP development

The product is the React web app. Install, run and integrate its modules using
[the TASK-2.1 foundation handoff](docs/web-foundation.md). The ScreenBridge v1
field schema and lifecycle semantics follow the A/B agreement in doc-7; the
`start`/`resume` commands keep the accepted `Promise<void>` shape. See
[the contracts package](packages/contracts/README.md). The macOS prototype remains
a frozen bonus. The root npm workspace uses TypeScript 7.0.2 and checks the shared
contracts, API, web shell boundary and `packages/agent` together.
