# BYOK Anthropic key — per-customer storage design (Tier-2 proposal)

**Status:** DESIGN for founder review (Tier-2 per `docs/planning/21-agent-autonomy.md`: customer data handling). Customer Anthropic API key storage column + settings UI not yet shipped. SHIPPED so far is the request-level plumbing (header → route → AgentRuntime → DecomposeArgs) per commits `1b97a5e0` + `f2a6c603`.

**Why now:** Tier-3 verdict 2026-05-16 LOCKED BYOK Anthropic for v1.0. The header-channel works fine for SDK consumers who pass the key per-request, but the customer-dashboard chat UI needs the key stored per-account so customers don't have to paste it every chat turn. Until storage lands, the dashboard chat-UI option is "session-cookie-only" (lost on tab close), which is poor UX.

**Source of truth:** `docs/internal/ai-chat-agent-layer-design.md` §"C — Billing integration" / "C1. BYOK" + `ORCHESTRATOR-STATE.md` Tier-3 verdict 2026-05-16 BYOK lock.

---

## Proposed shape

### `accounts` table column (NEW)

```sql
ALTER TABLE accounts
  ADD COLUMN byok_anthropic_api_key_ciphertext bytea NULL,
  ADD COLUMN byok_anthropic_api_key_set_at timestamptz NULL,
  ADD COLUMN byok_anthropic_api_key_last_used_at timestamptz NULL;
```

**Encryption:** AES-256-GCM via the existing `MFA_ENCRYPTION_KEY` env var (same key used for MFA secrets per `apps/server/src/lib/config.ts` and the V-353b MFA enrollment system). The key never round-trips to the dashboard / SDK / logs — only the server-side decompose path can read the plaintext, and only at request time.

**Why a separate set_at vs updated_at:** existing `accounts.updated_at` covers all account mutations; the dedicated `byok_anthropic_api_key_set_at` lets the dashboard show "Key configured on …" without needing to retain audit-log history. The `last_used_at` field is what powers the "your key last used X minutes ago" trust indicator.

**Why ciphertext + NULL is the contract:** `NULL` means "no BYOK key set" — the AgentRuntime falls back to `config.byokAnthropic.fallbackApiKey` (founder demo key). Any non-NULL ciphertext means the customer has provided a key; the AgentRuntime resolves to the customer's key.

### Customer dashboard surface (NEW)

Settings page `/settings/byok-anthropic` (or extension of existing `/settings` page):

- **Input form** — single password-type input + `Save` button. Server validates the format (`sk-ant-*` prefix; Anthropic key format) before storing.
- **State indicator** — "Key configured on May 14, 2026" + "last used 3 minutes ago".
- **`Clear key` button** — DELETE, sets ciphertext + timestamps to NULL.
- **`Test connection` button** — fires a tiny `messages` API call to Anthropic with the stored key; surfaces ok / quota-exceeded / invalid-key errors. Returns NO part of the key value to the dashboard — only the connection-test result.

### API endpoints (NEW)

```
PUT    /v1/account/me/byok-anthropic-key      — set or rotate (encrypts + stores)
DELETE /v1/account/me/byok-anthropic-key      — clear (NULL the ciphertext)
GET    /v1/account/me/byok-anthropic-key      — read METADATA only (set_at, last_used_at)
                                                — NEVER returns the plaintext
POST   /v1/account/me/byok-anthropic-key/test — fire a test call against Anthropic
```

Auth: `requireAuth` + `account_owner` scope (the customer themselves; not team members — BYOK key is owner-only). Audit-log entry on PUT + DELETE + test (per V-216 customer audit log pattern).

### Runtime resolution change

Current header-only path:

```ts
// apps/server/src/routes/agent-sessions.ts
const headerByokKey = typeof req.headers['x-byok-anthropic-api-key'] === 'string' ? ... : undefined;
runtime.runTurn({ byokApiKey: headerByokKey });
```

New customer-key-storage path (post-this-design):

```ts
const headerByokKey = ...;
// Priority: header (per-request override; useful for SDK consumers)
//           → stored customer key (per-account; dashboard chat UI path)
//           → deployment fallback (founder demo key).
const customerKey = await accountsRepo.getByokAnthropicKeyPlaintext(ctx.account.id);
const fallback = config.byokAnthropic?.fallbackApiKey;
const resolvedKey = headerByokKey ?? customerKey ?? fallback;
runtime.runTurn({ byokApiKey: resolvedKey });
```

`accountsRepo.getByokAnthropicKeyPlaintext` is the only place the plaintext appears outside the AgentDecomposer Claude call itself. Tagged with a TypeScript brand type `BYOKKeyPlaintext extends string & { readonly _b: 'byok-anthropic-plaintext' }` so the compiler refuses to log it without an explicit unsafe cast.

---

## Choices that need founder input

1. **Encryption key reuse vs dedicated.** Proposed reuse of `MFA_ENCRYPTION_KEY` (already exists; one less env var to manage). Alternative: dedicated `BYOK_ENCRYPTION_KEY` env var (clean compartmentalization; rotating MFA key doesn't invalidate BYOK keys). Reuse wins on operational simplicity; dedicated wins on key-rotation independence. Founder verdict?

2. **Audit log entry includes the key prefix (e.g. last 4 chars)?** Helps customers identify "which key is this audit row about" but expands the secret-leakage surface. Proposed: NO — audit log records "BYOK key set/cleared/used" with a timestamp + account_id, no fingerprint of the key value. Founder verdict?

3. **Team-scope sharing.** Proposed: BYOK key is account_owner-only. Team members on a shared account can USE the key (the AgentRuntime resolves from the owner's account) but cannot SET/CLEAR/TEST it. Alternative: team-scope-shared, where any team-admin can manage the key. Owner-only wins on principle-of-least-privilege; team-shared wins on operational flexibility. Founder verdict?

4. **Quota visibility.** Anthropic returns rate-limit headers on every response. Should we surface "you have X requests / Y tokens left this minute" in the dashboard chat UI? Proposed: NO at v1.0 — too easy to mis-display; Anthropic's own dashboard is authoritative; we'd be reading our own request's rate-limit header which doesn't tell the customer about their OTHER apps consuming the same key. Founder verdict?

5. **Bundled-LLM v1.1 migration path.** When bundled-LLM lands (v1.1 per Tier-3 verdict), customers without a BYOK key get Driftstack's bundled key + per-token billing. Schema impact: add `accounts.llm_billing_mode enum('byok', 'bundled', 'auto')`. Auto = use BYOK if set, fall through to bundled. Founder verdict on column shape now vs deferring?

---

## Migration plan (lands as separate slice after founder review)

1. Write `apps/server/src/db/migrations/<timestamp>-add-byok-anthropic-key.sql` matching the columns above.
2. Update `_journal.json` (V-228 backstop).
3. Update Drizzle schema `apps/server/src/db/schema.ts` accounts table.
4. Implement `accountsRepo.{setByokAnthropicKey,clearByokAnthropicKey,getByokAnthropicKeyPlaintext,getByokAnthropicKeyMetadata}`.
5. Wire the 4 new `/v1/account/me/byok-anthropic-key*` route handlers + W-numbered drift guard tests.
6. AgentRuntime resolution change per the sketch above.
7. Customer dashboard `/settings/byok-anthropic` page + Astro tests.
8. Audit log entries on PUT/DELETE/test.

Estimated landing scope: ~400 LOC + ~5 tests, single arc over 1-2 focused sessions after founder approval on the open questions.

---

## What this design does NOT cover (separate slices)

- Bundled-LLM billing (v1.1 — per-token metering against Driftstack-billed key + Stripe usage records).
- Anthropic key rotation automation (renewal-flow with customer notification).
- Multi-LLM-provider support (Anthropic + OpenAI + custom endpoint per planning 132 §"Phase 7" Customer 5.x).
- Cost-tracking dashboard for BYOK customers (show "you've used X tokens this billing period against your own Anthropic account") — would require us to track per-customer usage even when we're not billing, which is invasive.
