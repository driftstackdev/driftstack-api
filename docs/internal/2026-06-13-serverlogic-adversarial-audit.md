# Server-side business-logic adversarial audit — 2026-06-13 (clean)

**Result: 0 confirmed findings.** A fresh multi-agent adversarial audit of the
Agent-2 server-side subsystems that the earlier frontend/GUI punch-list audit
did not cover. 8 finder agents (one per subsystem) surfaced 8 candidate issues;
all 8 were refuted by a 3-skeptic adversarial verify (correctness /
security / reachability lenses, majority-refute). 29 agents, ~1.49M tokens.

## Subsystems audited (each finder checked prior memory to skip mined veins)

| Subsystem               | Lens                                                          |
| ----------------------- | ------------------------------------------------------------- |
| webhook-delivery        | HMAC signing, retry/backoff exhaustion, replay/dedup, SSRF    |
| crypto-charge / billing | double-charge, IPN replay, amount/currency tamper, state m/c  |
| profile-snapshots       | cross-account restore, DEK/secret handling, restore integrity |
| idempotency             | cross-account key reuse, TTL races, response replay           |
| pagination              | cursor tamper, cross-account leakage, non-advancing cursors   |
| recapture-automation    | scheduler races, retry/priority, unbounded queue growth       |
| recipe-library          | untrusted input, unbounded step generation, selector inject   |
| audit-log               | tamper/omission, export ceiling bypass, PII over-exposure     |

## Candidates raised, then refuted (do not re-report)

- **recipe-library "unbounded step generation" (DoS), 4 findings.** The recipe
  builders (`buildPaginatedListingRecipe`, `buildFillFormRecipe`,
  `buildCheckoutRecipe`, `buildWizardRecipe`) take their counts
  (`pageCount`/`fields`/`steps`) from **internal recipe-builder callers** — the
  authored V-532.A/B/C recipe set, with small fixed counts and `>= 1`
  validation — not from customer free-text. Not customer-reachable. Verified
  independently against the source, not just the skeptics' verdict.
- **recapture `atlas.ts` snapshot-key collision** via `@`/`+` in an archetype
  ID — archetype IDs are a locked allowlist (the 16pro→17 cutover is itself
  gated), never customer free-text. No injection vector.
- **recipe-library CSS-selector injection** — selectors are author-defined in
  the recipe set, not untrusted input.
- **webhook-worker auto-disable threshold** using the in-memory
  `consecutiveFailures + 1` snapshot — even under a hypothetical concurrent
  read, auto-disable is a safety feature and an off-by-one is benign; the
  worker's processing + DB reconciliation make the miscount unreachable in
  practice.
- **agent-sessions idempotent-response divergence** (LiveKit token expiry) —
  refuted; and agent-sessions is a founder-gated zone (DEK / effective-account
  / strict-FK) that would be surfaced, never flipped, regardless.

## Standing posture

Agent-2 server-side business logic is in good shape. The one real open
production gap remains the **CF-Connecting-IP origin spoof**
(`2026-06-13-cf-connecting-ip-spoof-origin-exposure.md`) — ops/founder-gated,
not a code fix. The frontend-perfection punch-list is closed
(`2026-06-13-frontend-perfection-punchlist.md`).
