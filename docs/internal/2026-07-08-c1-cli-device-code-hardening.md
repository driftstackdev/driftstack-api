# CLI device-code hardening (audit-2 C1 / C2 / D1) — decisions + rollout

**Date:** 2026-07-08
**Author:** autopilot (full decision authority per founder handoff)
**Commits:** `89620a6cb` (C2 + D1), `d93e5f032` (C1)
**Supersedes the "flagged for founder" status of audit-2 C1/C2/D1** in
`2026-07-08-fable-lasthours-audit-2-findings.md` — these are now decided,
implemented, tested, and ride the next staged API deploy.

---

## The problem (recap)

The CLI/GUI device-code flow (`routes/auth-cli.ts`,
`services/cli-authorize.ts`) minted a full-access `account_owner` key with
the only device↔account binding being a `state` nonce the initiator picks
and which travels in the browser URL. So an attacker could call the public
`/initiate`, send the one-click `browser_url` to a logged-in victim, and on
the victim's Authorize click receive (via `/exchange`) a plaintext
`account_owner` key on the victim's account — full account takeover (C1).
Plus: the exchange delivered the one-shot key non-atomically (C2, double
delivery under concurrent polls) and stored the plaintext key in Redis in
the clear (D1).

## What the server can and cannot fix

The **root cause** of the phish — the attacker chooses `state`, the victim
one-clicks a real-origin link — is a property of the _consent page_
(`apps/customer-dashboard/src/pages/cli/authorize.astro`), which is a
**separate engineer's locked lane**. Closing it needs the browser to prove
device presence: an RFC-8628 `user_code` shown ON the device and typed into
the consent page, or device/IP context the human can judge. **No
server-only change closes it.** So the server-side goal is reframed:

> Make a successful phish **non-catastrophic and non-persistent** — a
> phished device key must not be able to take over or drain the account —
> while the true anti-phishing fix is flagged for the dashboard owner.

## Decisions made (with authority) + rationale

### C1 — provenance deny-gate, NOT scope-narrowing (`d93e5f032`)

- **Kept the minted key `account_owner`.** Verified the live desktop client
  performs `account_owner`-gated _writes_ (`PUT /account/me/organization`,
  `PUT/POST /account/me/proxies`, `PATCH /account/me/bundled-llm-settings`),
  and there is no granular scope below `account_owner` for those — so blunt
  narrowing to `['read','write']` would 403 the live client. Rejected.
- **Marked device keys** with a new nullable `api_keys.provenance` column
  (`'cli_device'`; migration `0098`). Threaded through the read model
  (`ApiKeyRow`, both `toApiKeyRow` mappers, the auth-cache serialize/
  deserialize with an undefined→null **fail-open** default) and the mint
  path. Web sessions are stamped `provenance: null` so a dashboard/staff
  session is never treated as a device key.
- **Central deny-gate** (`middleware/device-key-deny.ts`): a global
  preHandler keyed on the matched Fastify **route template** 403s a device
  key on the account-takeover / persistence / exfil routes — mint/rotate/
  revoke API keys, MFA, team invite/remove, Stripe checkout/portal, **all
  webhook writes**, BYOK, web-session revocation.
  - **Why route-template, not a `requireScope` wrapper:** the sharpest
    vectors are `requireAuth`-only routes that enforce `account_owner`
    _inside the service_ (customer key mint/rotate/revoke in `routes/admin.ts`;
    every webhook write in `routes/webhooks.ts`), so a scope preHandler
    never fires on them. **Webhook creation is decisive** — a device key
    could otherwise stand up an attacker webhook that keeps exfiltrating the
    victim's event stream even after the device key is revoked
    (revocation-surviving persistence).
  - **Purely additive:** the gate only adds a 403 for a positively-
    identified device key; if lazy-auth fails (absent/bad token, or a
    feature-disabled stub route with no `requireAuth` — e.g. billing-
    disabled → 503) it swallows the error and defers to the route. It is
    never the primary authenticator. (This corrected a first cut that
    force-authed every deny route and turned the billing-disabled 503 into a
    401 — caught by the integration sweep.)
- **Defense in depth:** the `apiKeysService` create/rotate/revoke
  chokepoint independently rejects a `cli_device` caller, and **`/bind` now
  requires an interactive web session** (no API-key-authed bind), closing
  the self-mint laundering path (public `/initiate` + key-authed `/bind` +
  `/exchange` would otherwise let any key mint a fresh key for itself, and a
  device key mint a sibling that dodges its own gate).

### C2 — atomic one-shot exchange (`89620a6cb`)

Added `getDel` to the KV-store contract and claim the bound code with it
(Redis via a **version-independent Lua** get+del — no dependency on Redis
≥6.2; the in-memory store is atomic by single-threaded read-delete). Of two
concurrent bound polls exactly one wins; the loser gets `expired`.

### D1 — encrypt the minted key at rest (`89620a6cb`)

The key is stored in Redis as an AES-256-GCM blob under the shared
`MFA_ENCRYPTION_KEY` envelope (same as MFA/BYOK/platform secrets),
decrypted only at delivery. Encryption is **optional with a plaintext
fallback** (availability-first — a missing key degrades rather than breaking
desktop sign-in). Post-bind TTL shortened 5 min → 2 min.

## Residual risk (honest)

A phished device key can STILL, until it is revoked: drive browser sessions
on the victim's account (using their profiles / paid compute) and read
account data. This is bounded, visible in the dashboard, and fully evicted
by revoking the one key — it can no longer mint a persistent credential,
add a team member, change billing, disable MFA, create an exfil webhook, or
nuke the human's web sessions. The path from "one-click phish → total,
persistent account takeover" is closed to "one-click phish → bounded,
revocable session access." Full closure needs the dashboard `user_code`.

## Rollout — forward-only (deliberate)

Existing `'Desktop client'` keys keep `provenance` NULL (unrestricted).
Only keys minted after this deploys are gated. **Do not backfill** existing
device keys until a staging soak confirms no device-need route is wrongly
denied — a missed device-need would 403 the live fleet (incl. the locked
simulator bundle). The deny-set is pinned by an integration test that
drives a real device key against **every** deny template (a typo'd template
fails open and this catches it) and asserts disjointness from the
gui-client's device-need routes.

## Flagged for the dashboard / gui-client owners (foreign lane — coordinate)

1. **Anti-phishing `user_code` (the real fix).** Add an RFC-8628 `user_code`
   the device displays and the consent page requires (or a device-held PKCE
   verifier absent from the browser URL). Server can add OPTIONAL
   forward-compat `user_code`/`code_challenge` fields to
   `packages/api-types/src/cli-authorize.ts` (verified-when-present, no-op
   when absent) as a staged follow-up — but it is INERT until the consent
   page collects/echoes it, and it carries an openapi.json regen + an
   sdk-go struct field + pins. Not shipped here (needs the dashboard).
2. **Consent copy reword.** `authorize.astro` still says the key has "the
   same access as your web session" / "the same scope as your dashboard
   session". The device key is now MORE restricted than the web session.
   Reword; then the two server-owned mirror pins
   (`dashboard-cli-authorize-page-parity.test.ts`,
   `customer-dashboard-pages-cli-authorize-content-parity.test.ts`) update
   in lockstep AFTER the `.astro` edit.
3. **Backfill decision (founder call).** After a staging soak, whether/when
   to backfill existing `'Desktop client'` keys to `provenance='cli_device'`
   (retroactively restricting them). Recommend: backfill once the soak is
   clean — it closes the gap for already-issued device keys.
