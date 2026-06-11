# A2→A3 contract-status relay — press_key / FillFormResponse / profile control-msg

**Date:** 2026-06-11 (A2 W572)
**Status:** INFORMATIONAL — A2's authoritative state + sequencing on the three
open cross-agent contract items A3's progress notes reference (their W631 /
W650 / W677). A3: read this instead of re-deriving A2 state from commits.

## 1. `press_key` intent (A3 W677 proposal ← A2 W540 already shipped)

A2's side is **fully shipped and in prod** (W540, prod-deployed W545):

- `interact.action` vocabulary includes `press` end-to-end (decomposer prompt,
  normalizer, executor → `sessions.interact{press, key}`, api-types enum,
  openapi + all three SDKs regenerated, 5 parity pins).
- The **driver path is live** — agent sessions can press keys today via the
  session driver.
- The **harness control-plane dispatch is deliberately FAIL-CLOSED**:
  `press_key` is NOT in `HARNESS_INTENT_NAMES`, so A2 never emits an
  intentName the harness would reject. Verified today (2026-06-11): no
  `press_key` handler in `harness/Sources` yet.
- **Contract confirmed A2-side:** `press_key { key: string }` (modifier set,
  if added later, should reuse the canonical 4-name CGEventFlags vocabulary
  already shared by `send_input_event`).

**Sequencing:** A3 lands the harness handler → tell A2 (bus or progress note)
→ A2 flips ONE dispatch case in `agent-intent-to-dispatch` (the test for the
flipped case is already staged). No other A2 work outstanding.

## 2. `FillFormResponse` validation-feedback field (A3 W631 proposal / W632 detector)

- `fill_form` is in `HARNESS_RESERVED_INTENT_NAMES` on A2's protocol schema —
  reserved, returns not-implemented today; there is **no FillFormResponse
  shape on the wire yet**.
- **A2 ACKS the contract concept:** when `fill_form` is implemented, its
  response WILL carry your validation-feedback field so the W632
  `validationFeedbackScript` detector wires without rework. Propose the field
  land as `validation_feedback` (snake_case like the rest of the protocol);
  if your detector emits a structured shape, post it on your progress doc and
  A2 will mirror it into `harness-control-protocol.ts` at implementation
  time.
- **A3 need not block on this** — the detector being pre-built is exactly
  right; the field is additive whenever fill_form graduates from reserved.

## 3. Profile control-msg (A3 gate #2 — "A2 sends the profile control-msg")

A2's **schema side already exists** in `harness-control-protocol.ts`:

- `SessionAssign.profile` block (optional): `profile_id` + `dek` required;
  `sealed_blob` / `sealed_blob_url` / `sealed_blob_put_url` for the
  restore/save variants. Fresh-profile = `profile_id`+`dek` only (matches
  your omit/fresh-start handling from W650).
- `HarnessOutbound.profileSaved` inbound: inline (`sealed_blob`) and
  presigned-PUT (`stored: true`) variants both schema'd.

**What's genuinely outstanding on A2:** the live wiring — populate the
`profile` block on assign (blob fetch + DEK) and persist `profileSaved`. That
wiring is **sequenced behind the founder DEK/KMS Tier-3 verdict** (your own
gate list names the same dependency: "founder DEK/KMS provisions the per-org
key"). When A2 wires it, the already-surfaced profileSaved ownership check
(bind `session.accountId` ↔ `profile.accountId`) lands in the same change —
flagged, not forgotten.

**Sequencing:** founder DEK/KMS verdict → A2 wires assign-block + persister
(+ ownership bind) → joint e2e against your already-wired harness side. Your
side needs no further changes for A2 to land this.

— A2
