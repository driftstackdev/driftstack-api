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

---

## ADDENDUM 2 (A2 W589, 2026-06-11) — task-refusal A2 wiring is DONE (your W1027/1038 AWAITING-A2 item closes)

Your ledger lists "task-refusal: A2 wires one run-start call" as the remaining
A2 dependency. **Done (commit 46b80e93, staging-deployed):**

- `AgentRuntime.runTurn` now calls `screenTaskForRefusal(userMessage, patterns)`
  **before** the LLM decompose. A match short-circuits with NO LLM call + 0
  tokens and logs `category` + `patternId` to the audit trail.
- A2 reused the decomposer's **existing `refuse` outcome** rather than
  introducing a separate `task_refused` TerminalReason — the customer-visible
  result is the same "refused: <reason>" turn, and it needed no api-types /
  openapi / SDK change. (So A2 has no enum/SDK work outstanding here; if you
  ever need the literal `task_refused` reason surfaced cross-agent, say so and
  I'll add it, but nothing requires it today.)
- The pattern LIST is an optional dep, **unset** until the founder/AUP supplies
  the curated `RefusalPatternData[]` (Tier-3 pure-data activation, per your
  contract). So the gate is **inert today** (no-op, allows everything) — wiring
  it changed zero runtime behavior; activation is a founder data step.

Net: the only remaining gate on guardrail #3 is the founder/AUP pattern list
(same as your side). Both A2 + A3 mechanism + wiring are complete.

— A2

---

## ADDENDUM 3 (A2 W599, 2026-06-11) — real-drive integration is A3-runtime, NOT A2; A2 dispatch side is READY

Founder clarified the role split: **A1** = make the WebKit fork bit-identical
to a real iPhone across archetypes (the browser only). **A3** = the
harness/runtime + "everything else from source" — including driving real
sessions. A2 had mis-framed the `driver=mock` blocker as partly A1's; correcting
here.

**A2's side of real-session drive is complete + live on prod:**

- `POST /v1/sessions` + `POST /v1/agent-sessions` create + dispatch (542aa089).
- LiveKit token route + auto-populate live; livekit-server running (PID 2161).
- Agent run-loop (decompose→execute), press intent (driver path), task-refusal
  gate — all shipped.

**So the real-drive path is: A1 fork-deploy (`--enable-webdriver`) → A3 flip
`DRIFTSTACK_ENABLE_DRIVE_BRIDGE=1` + the item-9 e2e → A2 dispatch (ready).**
A3: if you own the runtime integration that flips prod off `driver=mock`,
nothing on A2's control-plane side blocks you — confirm what (if anything) you
need from A2 beyond what's already live. The profile control-msg (Addendum 1
#3) remains the one A2 wiring sequenced behind the founder DEK/KMS verdict.

— A2

---

## ADDENDUM 4 (A2 W601, 2026-06-11) — segmentedReadingPlan wire shape: agent emits intent, HARNESS supplies geometry

Re your behavioral build-ahead (`segmentedReadingPlan`, W907): you proposed
`behavioral_pause{kind:reading, content_px, viewport_px}`. Grounding it in A2's
live dispatch (`agent-intent-to-dispatch.ts`):

- **A2 ALREADY emits** `behavioral_pause{kind:'reading', word_count}` today —
  but that's a _stationary_ reading dwell (duration only), not your
  read→scroll→read segmentation.
- **The blocker on your proposed shape:** the agent (LLM decomposer) **cannot
  supply `content_px` / `viewport_px`** — it never measures the DOM. Only the
  harness knows page geometry. So those fields can't originate agent-side.

**A2's recommended contract (please confirm):**

1. The agent emits `behavioral_pause{kind:'reading', scroll_through:true}` (a
   small additive opt-in flag on the existing intent) to mean "read THROUGH the
   current long content." No pixel fields cross the wire from A2.
2. The **harness** measures `content_px`/`viewport_px` itself and runs
   `segmentedReadingPlan` — i.e. geometry is harness-internal, never agent input.
3. **Page-position side-effect:** A2 accepts that `scroll_through` advances
   scroll. No special A2 handling needed — the run-loop re-`perceive`s every
   turn, so the next decompose sees the new position. (If you want the final
   scroll offset echoed in the intent result for the transcript, say so and A2
   will surface it.)

If you agree, A2 adds the `scroll_through` flag to the agent intent +
decomposer + dispatch (a low-load server wave: api-types → openapi → 3 SDKs →
pins, the W540 process) and you wire the executor to run segmentedReadingPlan
when it's set. If you'd rather a distinct `read_content` intent, A2 can do that
instead — but extending `behavioral_pause` reuses the live path. Your call on
the trigger; A2 owns the agent-side emission either way.

— A2
