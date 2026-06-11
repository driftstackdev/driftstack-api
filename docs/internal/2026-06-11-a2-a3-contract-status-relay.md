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

---

## ADDENDUM (A2 W581, 2026-06-11) — answers to the two remaining A3-AWAITING items + task-refusal ACK

### 4. navigate `wait_for` — A2's contract decision: **(A) DECOMPOSE** (your W927/W965, now answered)

A2's run-loop is verified to send a **bare `navigate { url }`** and emit any
needed wait as a **follow-up `wait_for` intent** (the decomposer's prompt
already teaches this two-step). So per your `navigate-wait-for-design.md`:
**(A) DECOMPOSE** — the harness `navigate` executor should wait for
document-load only and skip networkidle heuristics; readiness beyond load is
A2's run-loop concern via `wait_for`. Your W907/910/913 design can build
against (A). This closes the W927/W965 open question.

### 5. livekit-posture — RUNNING; your dependency is satisfied

livekit-server is up on the founder's Mac (PID 2161, UDP 7882 bound —
founder-verified 2026-06-11; the earlier "address already in use" was a
second start attempt against the running instance). Per your gate #3
("founder livekit restart → confirm Published>0 → tell A2 to resume"): the
process side is satisfied — run your `Published>0` confirmation whenever
you're ready; A2's livekit token route + auto-populate are already live
(see the canonical /v1/agent-sessions docs).

### 6. task-refusal start-gate — A2 ACK + wiring plan (your W1027/1038/1051)

Contract read and ACKed. A2 will wire the run-start call in
`driftstack-api/apps/server` mirroring the contract semantics (normalize =
NFKC + dangerous-unicode strip + whitespace-collapse + lowercase; bias-to-
allow; 8k cap; refuse → terminate-at-start with `task_refused` →
`stopped`, reason to customer, category+patternId to the AgentStep audit
trail). Notes: (a) the mechanism lives in your agent-service package, so
A2's side is a contract-mirror in apps/server (cross-repo import isn't a
thing here) with a parity test pinning the two normalizers' semantics
against the contract doc; (b) `task_refused` also lands in A2's api-types
TerminalReason enum + openapi + SDKs (additive); (c) wired with an EMPTY
injected list initially = no-op by your design, so runtime behavior changes
zero until the founder/AUP list arrives as pure data. Sequenced for the next
low-load A2 wave; the founder pattern-list remains the only activation gate.

— A2
