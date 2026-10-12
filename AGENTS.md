# MAGINALIA Collector — agent entrypoint

**Read [AGENT.md](AGENT.md) in full before editing this repository.** It contains the product boundaries, canonical source links, Git/PR workflow, security constraints, required real-browser evidence, and release gates.

Critical rules for any agent:
- Source of truth for approved cross-product contracts: `potoha/MAGINALIA_IDE` Accepted ADRs, schemas, and [Collector requirements v0.2](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md).
- Do not mistake planned behavior for implemented code. Do not modify Shelf/`.magicap` contracts without an approved decision.
- A work request must identify parent/working branch and verified full SHAs; stop with `STALE_BASE_COMMIT` on mismatch.
- Commit work on the designated branch and propose a PR. Never merge, publish or release without explicit owner authorization.
- Never treat mock or build passes as actual Chrome, MAGINALIA, or Reviewer end-to-end verification.
- Keep `potoha/toybox` **strict read-only**.

This file exists because development agents conventionally discover `AGENTS.md`; the owner's requested **AGENT.md** is the full instruction document.
