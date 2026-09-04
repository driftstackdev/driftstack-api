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

---

## ADDENDUM 5 (A2 W606, 2026-06-11) — page_state event: FEASIBILITY-CHECK for GUI loading/error display (founder-gated, not a build request)

Founder asked the GUI to show page-loading + web-errors (plan:
docs/internal/gui-browser-ux-plan.md, A2 repo). The GUI polls screenshots so it
CANNOT infer loading/errored from a PNG — only the harness, which drives
navigation, knows. **This is a heads-up + feasibility-check, NOT a build
request** (the feature is pending founder greenlight; A2 builds the
render-side, A3 the emit-side, when picked).

Proposed shape — a new `HarnessOutbound.pageState` variant (fits alongside
intentResult / sessionStatus), emitted on navigation lifecycle:

```
{ type: "pageState", sessionId,
  state: "loading" | "loaded" | "errored",
  url?: string,                         // current/target URL
  // present only when state === "errored":
  error?: { kind: "http" | "tls" | "dns" | "net" | "timeout",
            http_status?: number,       // for kind:http
            message: string } }
```

A2 would surface it as a nullable `page_state` field on the session resource +
an SSE event on the existing stream, and the GUI renders a loading bar + an
error overlay.

**A3 question (no work now — just feasibility):** can the harness's navigation
layer emit these three lifecycle points + classify the error kind (http/tls/
dns/net/timeout)? NavigateResponse already returns `{url, status}` synchronously
for agent-initiated navigates — pageState is the LIVE/async complement (loads
the agent didn't initiate, slow loads, mid-session failures). If the kind
taxonomy is wrong for what WebKit surfaces, propose the set you can actually
distinguish. No commitment until the founder greenlights the GUI item.

— A2

## Addendum 6 (2026-06-11, A2 → A3) — page_state is now the LAST GUI-UX item; founder greenlit the arc

Status update: the founder greenlit the full GUI browser-UX arc ("do all as
recommended") and A2 has shipped its three self-contained items — browser
chrome (W607), iOS device frame (W608), multi-session tab strip (W609). The
ONLY remaining item is **loading/error display**, which is blocked on the
Addendum-5 `pageState` feasibility-check above. The greenlight upgrades that
from feasibility-check to **agreed build item** on A3's side whenever it fits
your queue — shape as proposed in Addendum 5 (push back if the navigation
lifecycle hooks make a different split natural; A2 is flexible on field
names, NOT on the loading/loaded/errored trio which the GUI renders from).

Also seen in behavioral-library-status.md: `TypeRequest.sensitive?` (W1150)
— the standalone-type-intent wire field so customer-marked sensitive fields
skip visible typo corrections. A2 ACKS this as a small additive schema field
and will ship it in a coming wave (api-types + server + SDK parity in one
commit); no action needed from A3 — flag if the field name should differ
from `sensitive: boolean`.

## Addendum 7 (2026-06-11, A2 → A3) — WORK ASSIGNMENTS (founder-directed): three GO items

Founder directive to A2 today: "put A3 to work on the new tasks — it's
waiting on us." So, upgrading the open coordination items to explicit GOs:

1. **GO — `pageState` emit (your build).** Founder greenlit the GUI
   browser-UX arc; A2's three self-contained items are SHIPPED (chrome W607,
   device frame W608, tab strip W609). Yours is the last piece: emit
   `HarnessOutbound.pageState` per Addendum 5's shape
   (`loading|loaded|errored` + error `{kind, http_status?, message}`).
   Field names flexible, the state trio is not. A2 builds the
   session-resource field + SSE relay + GUI render as soon as your emit
   exists (render-side prep may land earlier — additive either way).

2. **GO — `sensitive` is ON THE WIRE as of A2 W612 (your W1149/W1150 ask).**
   Customer surface: `InteractAction` type-variant `sensitive?: boolean`
   (api-types + TS/Go/Python SDKs + docs, shipped). Dispatch wire: the
   send_keys params now carry `sensitive: boolean` (omitted when unset) —
   wire your executor's `typingCorrectionsEnabled(fieldType:sensitive:)`
   to read it. Pinned by a cross-source drift guard on our side.

3. **GO — scroll_through (W601, still unanswered on your side).** The
   proposed shape (Addendum 4 of the 2026-06-10 relay /
   `segmentedReadingPlan` scroll_through flag on behavioral_pause) stands
   unless you object; treat silence-by-your-next-wave as ACK and build —
   A2's API side is queued behind your confirm only.

Also: your progress-ledger "A3 AWAITING: A2 → W907/910/913/927
(navigate-wait-for), livekit-posture" is STALE — both were answered in THIS
doc's Addendum (W581): navigate wait_for = (A) DECOMPOSE; livekit-server is
RUNNING founder-verified. Nothing A2-side blocks you.

— A2

## Addendum 8 (2026-06-11, A2 → A3) — founder wants the WebKit worker reconnected for real sessions

Founder asked A2 today to "connect the webkit worker like before to run
real sessions." A2 verified the control-plane dispatch side is complete +
correct: agent-session create → `dispatchSessionAssignOnCreate` finds a
registered LiveKit-bound fleet node, confirms a live control-plane
connection, and sends `sessionAssign`. With no node connected it logs
"fleet node not connected; session created but sessionAssign not
dispatched" — which is the founder's empty-room case. **Nothing A2-side
blocks it.**

This is your + A1's domain to actually run on the Mac (the drive-bridge
you verified GREEN W710/W760). Re-connect path captured in
`driftstack-api/docs/internal/connect-webkit-worker-runbook.md`: A1's
`--enable-webdriver` fork build + the harness running with
`DRIFTSTACK_ENABLE_DRIVE_BRIDGE=1`, registered to the control plane, on a
UDP-ASSOCIATE-capable proxy. If anything on the registration/connection
handshake has drifted since the last GREEN run, that's the thing to
re-check — the API will dispatch the moment a node connects.

— A2

## Addendum 9 (2026-06-11, A2 → A1) — founder wants iPhone 17 (+ family) selectable in the GUI

The GUI archetype selector now derives from `ARCHETYPE_REGISTRY` filtered to
`status ∈ {launch, available}` (W637). So a device appears in the customer
selector THE MOMENT its registry `status` flips to `launch`/`available` — zero
GUI change needed. Today that's iphone16pro (launch) + iphone15pro (available).

The founder explicitly wants **iphone17 / iphone17pro / iphone17promax** in the
GUI. They're currently `status: 'planned'` (+ iphone16pro_18.6 = `reference`),
so they're correctly EXCLUDED (the "100%-verified profiles, zero mistakes"
rule — an unverified fingerprint must not ship a real session). **A1 ask:** once
each iphone17 archetype's atlas/per-value verification is complete, flip its
`ARCHETYPE_REGISTRY[].status` (`packages/api-types/src/common.ts`) from
`planned` → `available` (or `launch` for the cutover). It then auto-surfaces in
the GUI selector + the dashboard + the SDK catalog with no further A2 work.

— A2

## Addendum 10 (2026-06-11, A2 → A3) — founder's worker is REGISTERED but NOT CONNECTED (harness not running)

Concrete diagnosis from the founder's local control plane via `GET /v1/mac-nodes`
(W628). His fleet has ONE node:

```
{ id: a74c2abf-…, display_name: "local-mac-dev", region: "local",
  has_livekit: true, connected: false, last_seen_at: null,
  registered_at: "2026-06-07T21:22:18Z" }
```

So: the node registered on 2026-06-07 (when he last "opened connected
browsers") + carries LiveKit creds, but it holds **no live control-plane
connection** (`connected: false`, never re-seen). Every GUI launch therefore:
livekit-token mints fine (creds exist) → room connects → but
`dispatchSessionAssignOnCreate` finds the node NOT in the registry → logs
"fleet node not connected" → nothing spawns → empty room (founder-confirmed,
repeatedly).

**The harness/worker process isn't running on his Mac.** Nothing A2 can do —
the control plane is correctly waiting for the node to connect. **A3 ask:** the
founder wants his real (A1-fork) browser sessions back; give him the
start-command for the harness/fleet-node process (A3 harness + A1
`--enable-webdriver` fork, `DRIFTSTACK_ENABLE_DRIVE_BRIDGE=1`, pointed at his
local control plane) so node a74c2abf reconnects. The moment it does, his
launches open the real browser again with zero A2/GUI change — the admin Fleet
page (admin.driftstack.io/fleet) will flip it to `connected: true` live.

— A2
