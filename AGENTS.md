# MAGINALIA Collector — agent entrypoint

**Read [AGENT.md](AGENT.md) in full before editing this repository.** It contains the product boundaries, canonical source links, Git/PR workflow, security constraints, required real-browser evidence, and release gates.

Critical rules for any agent:
- Source of truth for approved cross-product contracts: `potoha/MAGINALIA_IDE` Accepted ADRs, schemas, and [Collector requirements v0.2](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md).
- Do not mistake planned behavior for implemented code. Do not modify Shelf/`.magicap` contracts without an approved decision.
- A work request must identify parent/working branch and verified full SHAs; stop with `STALE_BASE_COMMIT` on mismatch.
- Commit work on the designated branch and propose a PR. Never merge, publish or release without explicit owner authorization.
- Never treat mock or build passes as actual Chrome, MAGINALIA, or Reviewer end-to-end verification.
- Keep `potoha/toybox` **strict read-only**.

## Default agent roles and models (Product Owner, 2026-10-31)

| Agent | Default model |
| --- | --- |
| Orchestrator | GPT-6.1 Terra High |
| Oracle | GPT-6.1 Sol High |
| Explorer | GPT-6 Luna Max |
| Designer | GPT-6.1 Terra High |
| Fixer | GPT-6 Luna Max |

- **Orchestrator:** coordinate scope, delegation, evidence and delivery.
- **Oracle:** resolve high-risk architecture and cross-product contracts; hand back bounded decisions and acceptance.
- **Explorer:** inspect current repository, relevant issues/tests, and reproduce failures.
- **Designer:** design user-visible capture, confirmation, onboarding and status UX within canonical plans.
- **Fixer:** perform bounded implementation, regression fixes and verification.

Model names above are requested **routing labels**. Check actual provider/model identifiers in the live agent harness before execution; if a route is missing, report it instead of silently substituting a different model. This table overrides older local routing references, but never overrides the Product Owner, accepted MAGINALIA_IDE decisions or the security rules in [AGENT.md](AGENT.md).

## Current integration and review gates

- [ADR 0019 / D070](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/decisions/0019-collector-native-messaging-host.md) **accepts Chrome Native Messaging** for explicit Collector actions. Desktop UI must not be required for ordinary web-quote save. The Host is restricted to the one Private Shelf configured by MAGINALIA and must not expose paths or arbitrary filesystem operations.
- Windows named-mutex + durable recovery are **verified as a disconnected PoC**, not as enabled production saving ([Desktop PR #82](https://github.com/potoha/MAGINALIA_desktop/pull/82)). Keep `save = unsupported_operation` and `writesEnabled: false` until the accepted product integration and real Chrome/Shelf E2E gates are satisfied. Consult the live Issues [Desktop #83](https://github.com/potoha/MAGINALIA_desktop/issues/83), [Desktop #84](https://github.com/potoha/MAGINALIA_desktop/issues/84), and [Collector #9](https://github.com/potoha/MAGINALIA-Collector/issues/9); do not treat this dated snapshot as current implementation truth.
- Record specifications and feedback in the responsible GitHub **Issue comments** and code review in **PR comments/reviews**. Chat is not the sole durable record. Cross-repo canonical decisions belong in MAGINALIA_IDE's plans/ADRs, not merely in PR prose.

This file exists because development agents conventionally discover `AGENTS.md`; the owner's requested **AGENT.md** is the full instruction document.
