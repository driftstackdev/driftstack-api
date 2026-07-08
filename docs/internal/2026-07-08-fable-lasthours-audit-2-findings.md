# Fable last-hours adversarial audit #2 — findings + founder decisions

**Date:** 2026-07-08
**Method:** 8-dimension adversarial audit (find → two refute-by-default verifier
lenses per finding) over genuinely-fresh auth/authz surfaces NOT covered by
audit #1: CLI device-code auth, OAuth client credential exchange, API-key +
V-481 scope machinery, team RBAC / act-as, rate-limit + quota, idempotency-key
handling, email opt-out enforcement, usage metering + cost accounting.
**Raw yield:** 17 findings → **12 CONFIRMED, 3 DISPUTED, 2 KILLED.** Every
survivor was independently re-verified against live source before any action.
Workflow `wf_3381f4ee-7ef` — 42 agents, 0 errors.

---

## SHIPPED THIS SESSION (clean, tested, ride the next staged API deploy)

### C6 — HIGH / money — every idempotent crypto checkout 500s on real Postgres

`apps/server/src/db/crypto-orders-repo.ts` insertWithIdempotencyKey

The `idempotency_key` unique index is PARTIAL (`WHERE idempotency_key IS NOT
NULL`), but the `onConflictDoNothing({ target })` omitted that predicate. Real
Postgres then can't match the arbiter and raises 42P10 ("no unique or exclusion
constraint matching the ON CONFLICT specification") — so **every crypto checkout
sent with an Idempotency-Key throws a 500 in production.** Invisible to the
pglite/in-memory tests (they don't enforce partial-index arbiter matching) — the
classic "DB-gated code unverified against real infra" trap. **Fix:** add
`where: sql\`idempotency_key IS NOT NULL\`` to the ON CONFLICT so it matches the
partial index. CI-gated real-Postgres reproduction test added.

### C5 — MEDIUM / authz — non-admin team member can replay the owner's webhook deliveries

`apps/server/src/routes/webhooks.ts` POST /v1/webhook-deliveries/:id/replay

Every webhook WRITE (create/update/delete/rotate) gates team act-as through
`effectiveAccountIdForWrite` (throws for a member role), but S32 wired the replay
route with the read-only act-as of `listDeliveries`. Replay RE-FIRES the delivery
— a write — so a non-admin member acting-as the owner could replay the owner's
deliveries. **Fix:** route replay through the same admin-only gate; +integration
test (member → 403).

### C3 — MEDIUM / data-leak — login timing enumeration of OAuth/IdP accounts

`apps/server/src/services/auth-flows.ts` login()

The CWE-208 login equalizer runs a dummy scrypt only when `passwordHash === null`.
OAuth/IdP accounts are created with the EMPTY-STRING sentinel (`createFromIdp`
writes `passwordHash: ''`), which falls through to `verifyPassword(pw, '')` —
that fails FAST in its catch (unparseable hash, zero scrypt work). So an OAuth-only
account's failed login returns in ~microseconds vs ~scrypt-time for a real
password account, re-opening the exact enumeration channel the branch exists to
close. **Fix:** treat the empty-string sentinel like null in the equalizer;
both content-parity security-invariant pins updated to lock it.

---

## FLAGGED FOR YOUR DECISION (design / policy / hot-path / foreign-lane / disputed)

### C1 — MEDIUM / auth-bypass — CLI device-code phishing → full account-takeover key

`apps/server/src/routes/auth-cli.ts` + `services/cli-authorize.ts`

**Serious, and the fix is a design change, so flagged rather than patched blind.**
The only link between the device that starts a CLI login and the account that
approves it is a `state` nonce the _initiator_ chooses and which travels in the
browser URL — not a device-held secret. So: attacker calls the public `/initiate`
(picks `state`) → gets a real-origin `browser_url` → sends the one-click link to a
logged-in victim → victim clicks Authorize → server mints an **account_owner**
(full-access, DEFAULT_SCOPES) key on the VICTIM's account bound to the attacker's
code → attacker polls `/exchange` with code+state and receives the plaintext key =
account takeover. The consent screen shows only the first 6 chars of an opaque
code — zero device identity. Note `client_label` is stored but never rendered AND
is attacker-controlled at `/initiate`, so "surface the label" is NOT a sufficient
fix. **Recommended:** (a) RFC-8628-style user_code shown ON the device and typed
into the browser (proves the human is at the initiating device), or a
device-held PKCE-style verifier absent from the browser URL; (b) narrow the
minted key's default scope below account_owner; (c) show real device/IP context on
consent. Spans server + the dashboard consent page (authorize.astro).

### C7 / C8 — MEDIUM+LOW / money — crypto checkout idempotent replay is order-status-blind

`apps/server/src/routes/billing-crypto.ts`

A replayed Idempotency-Key returns the STORED order as a 201 regardless of its
current status — so a swept/expired (`failed`) order re-surfaces its dead
NowPayments payment address; a customer paying it loses the funds (C7). And when
the original NowPayments bind failed, a replay re-mints/re-binds a SECOND payment,
orphaning the address the customer was already told to pay (C8). Both need a
status-aware replay policy (re-mint vs refuse vs fresh-order) — a billing-flow
decision. Related to C6 (same idempotency path); ship C6 first, then design the
replay semantics.

### C10 — MEDIUM / data-leak — bundled-LLM turn leaks the real upstream cost

`apps/server/src/routes/agent-sessions.ts` (~:3807, turn response)

On bundled-LLM turns the response reports the real upstream Anthropic cost, not
the posted flat $0.10 (founder verdict Q5=A) — exposing the margin and
contradicting the pricing model. Flagged (not patched) because it sits in the
message/turn response path that the concurrent engineer is actively editing;
recommend they or you fix it there to report the flat rate on bundled turns.

### C11 — LOW / money — bundled $0.10 cost row can double-insert on write-retry

`apps/server/src/db/agent-decomposer-usage-recorder.ts`

`usage_records` has no idempotency key, so an ack-lost retry double-inserts the
$0.10 row (double-bills the customer). **Foreign lane** (agent-decomposer files
are being actively edited) — flagged for that engineer; the fix is a unique key
(session_id, turn_seq) or an upsert.

### C9 — LOW — signup-welcome opt-out (V-204) never enforced

`apps/server/src/services/auth-flows.ts` verifyEmail

`sendSignupWelcome` fires unconditionally; a re-verification (second outstanding
token) re-sends it after an explicit opt-out. Fix needs email-preferences wired
into AuthFlowsService (or routing the welcome through the S44 opt-out-aware
lifecycle dispatcher) — more than a 1-liner, so flagged.

### C2 — LOW / race — CLI exchange() double-delivers the one-shot key

`services/cli-authorize.ts` — non-atomic get-then-del; concurrent polls can both
receive the plaintext. Self-contained fix (Lua/GETDEL atomic claim). Bundle with
the C1 CLI-flow rework.

### C4 — LOW / crash — web-session token starting with "ds\_" is misrouted + rejected

`apps/server/src/services/auth.ts` isApiKeyShape — a random session-token body
beginning with `ds_` (~1 in 262k) routes to the API-key path and can never
authenticate (silent session break). Fix = fall through to the session lookup
when the API-key path misses, or guarantee session tokens never carry the prefix.
Touches the auth hot path — flagged for a careful review rather than an autonomous
edit.

### C12 — LOW — nightly cost recompute skips the final day of each billing cycle

`apps/server/src/services/cost-nightly-job.ts` — window boundary excludes the last
day, so a threshold crossing on month-end can never alert. Off-by-one in the
window; verify against D3 before fixing.

### DISPUTED (adjudicate)

- **D2 — MEDIUM — OAuth `state` not bound to the user agent; PKCE disabled for
  GitHub → login-CSRF / session swapping** (`routes/auth-oauth-client.ts`). One
  lens refuted, one confirmed. Worth a hard look: if the `state` isn't tied to a
  browser-session cookie AND GitHub has no PKCE, an attacker can fixate a login.
- **D3 — LOW — cost-monitoring pipeline possibly inert** (aggregator returns null
  for every account → alerts never fire). Conflicts with C12 (which assumes the
  pipeline runs); resolve them together.
- **D1 — LOW — bound authorization code stores the API-key plaintext + un-hashed
  code in Redis ~10 min.** Part of the C1 CLI-flow rework.

---

## Provenance

Full raw findings + both verifier reasonings: `scratchpad/audit2-findings-full.md`.
Audit #1 (2026-07-07) findings + shipped C4/C9: the sibling doc
`2026-07-07-fable-lasthours-audit-findings.md`.
