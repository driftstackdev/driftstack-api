// W547.B — drift guard for /docs/security-audit-2026-05-06.md.
// V-246 pre-launch security audit + V-498 closure status. Drift
// here either drops the P0/P1/P2 severity inventory (would lose
// the launch-blocking gate definition), removes the V-498 closure
// status table (would lose the post-V-246 audit follow-through), or
// changes the 10-clean inventory (would let regression on a
// previously-verified clean area slip).
//
//   • V-246 anchor + 'would I be embarrassed if this hit production
//     with the first paying customer?' bar.
//   • Summary: 1 P0 + 4 P1 + 5 P2 + 10 verified clean.
//   • P0-001: API key revocation race window (V-247 Option-B key-
//     version counter).
//   • P1-001/002/003/004: open-redirect / PII-in-logs / scope-leak /
//     IP-rate-limit.
//   • 10 verified-clean inventory (scope-check + plaintext + Stripe
//     idempotency + audit injection + account-scope + web-session
//     + CSRF + enumeration + cache version + multi-customer Stripe).
//   • V-498 closure status table.
//   • V-498 delta-audit re-checking V-481/V-484/V-485/V-486/V-487/
//     V-494 — no new P0/P1.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/security-audit-2026-05-06.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W547.B /docs/security-audit-2026-05-06.md content parity', () => {
  const body = read(LIB);

  it("Header + V-246 + embarrassment-bar + 14-file-scope framing pinned: '# Pre-launch security audit — 2026-05-06' + 'V-246. Walks `apps/server/` auth + payment + data-handling code paths against the \"would I be embarrassed if this hit production with the first paying customer?\" bar.' + 'Conducted via Explore agent reading 14 service/lib/route files; findings cross-checked by line citations.' — pinned so the V-246 + first-paying-customer-embarrassment-bar + 14-file-Explore-agent + line-citation cross-check commitment survives", () => {
    expect(body).toMatch(/^# Pre-launch security audit — 2026-05-06$/m);
    expect(body).toMatch(
      /V-246\. Walks `apps\/server\/` auth \+ payment \+ data-handling code paths/,
    );
    expect(body).toMatch(/against the "would I be embarrassed if this hit production with the/);
    expect(body).toMatch(/first paying customer\?" bar\./);
    expect(body).toMatch(/Conducted via Explore agent reading 14/);
    expect(body).toMatch(/service\/lib\/route files; findings cross-checked by line citations\./);
  });

  it("Severity summary + P0+P1-targeted-V-247+V-248 framing pinned: '## Summary' + '**P0 (launch-blocking)** | 1' + '**P1 (recommended)** | 4' + '**P2 (post-launch)** | 5' + '**Verified clean** | 10' + '**P0 + P1 fixes targeted for V-247 + V-248** (this V-246 entry is the audit doc; fixes land in subsequent commits).' — pinned so the 1-P0 + 4-P1 + 5-P2 + 10-clean inventory + V-247/V-248 fix targeting commitment survives", () => {
    expect(body).toMatch(/## Summary/);
    expect(body).toMatch(/\*\*P0 \(launch-blocking\)\*\*\s+\|\s+1/);
    expect(body).toMatch(/\*\*P1 \(recommended\)\*\*\s+\|\s+4/);
    expect(body).toMatch(/\*\*P2 \(post-launch\)\*\*\s+\|\s+5/);
    expect(body).toMatch(/\*\*Verified clean\*\*\s+\|\s+10/);
    expect(body).toMatch(
      /\*\*P0 \+ P1 fixes targeted for V-247 \+ V-248\*\* \(this V-246 entry is the audit doc; fixes land in subsequent commits\)\./,
    );
  });

  it("P0-001 API-key-revocation-race + Option-B-key-version-counter framing pinned: '## P0 — launch-blocking' + '### V-246-P0-001 — API key revocation race window' + '**File:** `apps/server/src/services/auth.ts` lines 150–159.' + 'when an API key is revoked, the DB write happens first (`revokedAt = now`), then the auth-cache entry for that key is invalidated. Between those two steps (microseconds), a concurrent request that read the cache before the invalidation can have a `AccountContext` with `revokedAt = null` cached.' + '**Fix shape (selected):** Option B (key-version counter), mirroring the existing account-version pattern (V-016 / D-025). Add a `key:version:<id>` Redis counter; bump on revocation; bake the version into the cache key so a stale entry is never read.' + 'Alternative considered but rejected: Option A (re-verify `revokedAt` from DB on every cache hit) — adds a DB query per cache hit, defeats the cache.' + '**Targeted at V-247.**' — pinned so the P0-001 + lines-150-159 + revoke→cache-invalidate race window + Option-B-key-version-counter selected + Option-A-rejected-defeats-cache + V-016/D-025 account-version-pattern-mirror + V-247-targeting commitment survives", () => {
    expect(body).toMatch(/## P0 — launch-blocking/);
    expect(body).toMatch(/### V-246-P0-001 — API key revocation race window/);
    expect(body).toMatch(/\*\*File:\*\* `apps\/server\/src\/services\/auth\.ts` lines 150–159\./);
    expect(body).toMatch(
      /when an API key is revoked, the DB write happens first \(`revokedAt = now`\), then the auth-cache entry for that key is invalidated\./,
    );
    expect(body).toMatch(
      /\*\*Fix shape \(selected\):\*\* Option B \(key-version counter\), mirroring the existing account-version pattern \(V-016 \/ D-025\)\./,
    );
    expect(body).toMatch(
      /Add a `key:version:<id>` Redis counter; bump on revocation; bake the version into the cache key so a stale entry is never read\./,
    );
    expect(body).toMatch(
      /Alternative considered but rejected: Option A \(re-verify `revokedAt` from DB on every cache hit\) — adds a DB query per cache hit, defeats the cache\./,
    );
    expect(body).toMatch(/\*\*Targeted at V-247\.\*\*/);

    // V-883 — the P0 above was closed by V-247 and sat under "P0 —
    // launch-blocking" without the resolution note this document uses
    // elsewhere (see the V616 note on P1-003). Asserted positively rather than
    // by banning the P0 heading: the finding text is an audit record and stays,
    // so what must be present is the status beside it. A resolved P0 does not
    // un-resolve, so this pin cannot expire the way V-794 warns about.
    expect(body, 'the P0 carries its resolution status').toMatch(
      /\*\*Status \(V-883, 2026-08-18\): resolved in application code\.\*\*/,
    );
    expect(body, 'and names the mechanism that closed it').toMatch(
      /per-key version counter\s*\n?\s*\(`auth:keyid:<id>:v`\), bumped by `invalidateKey\(\)`/,
    );
  });

  it("P1-001 open-redirect Stripe URL allowlist framing pinned: '### V-246-P1-001 — Open redirect in Stripe checkout return URLs' + '**File:** `apps/server/src/routes/billing.ts` lines 56–57, 76–77.' + '`POST /v1/billing/checkout-session` and `POST /v1/billing/trial-pack` accept `success_url` + `cancel_url` from the request body and pass them straight to Stripe's Checkout API. A malicious customer (or someone with a stolen API key) could craft a checkout link with `success_url: https://attacker.com/phishing`' + '**Fix shape:** validate `success_url` + `cancel_url` against a configured allowlist of origins (default: `https://app.driftstack.dev`). Customer needing custom URLs gets a clear error pointing at \"contact support\" for enterprise allowlisting.' + '**Targeted at V-248.**' — pinned so the P1-001 + billing.ts-lines-56-57+76-77 + Stripe-Checkout-success_url-cancel_url-pass-through + attacker.com/phishing-example + allowlist-default-app.driftstack.dev + enterprise-allowlist-support-path + V-248-targeting commitment survives", () => {
    expect(body).toMatch(/### V-246-P1-001 — Open redirect in Stripe checkout return URLs/);
    expect(body).toMatch(
      /\*\*File:\*\* `apps\/server\/src\/routes\/billing\.ts` lines 56–57, 76–77\./,
    );
    expect(body).toMatch(
      /`POST \/v1\/billing\/checkout-session` and `POST \/v1\/billing\/trial-pack` accept `success_url` \+ `cancel_url`/,
    );
    expect(body).toMatch(/from the request body and pass them straight to Stripe's Checkout API\./);
    expect(body).toMatch(/`success_url: https:\/\/attacker\.com\/phishing`/);
    expect(body).toMatch(
      /\*\*Fix shape:\*\* validate `success_url` \+ `cancel_url` against a configured allowlist of origins \(default: `https:\/\/app\.driftstack\.dev`\)\./,
    );
    expect(body).toMatch(/\*\*Targeted at V-248\.\*\*/);

    // V-884 — P1-001 and P1-002 both sat without the resolution note this
    // document uses elsewhere. P1-001's fix is in billing.ts; P1-002's action
    // was a runbook section, which exists. Findings left intact; only the
    // status is asserted, and a resolved finding does not un-resolve.
    expect(body, 'P1-001 carries its resolution').toMatch(
      /\*\*Status \(V-884, 2026-08-18\): resolved in application code\.\*\* `billing\.ts`/,
    );
    expect(body, 'and names the allowlist that closed it').toMatch(
      /rejects any origin not\s*\n?\s*on `ALLOWED_RETURN_ORIGINS`/,
    );
    expect(body, 'P1-002 records that its documentation action is complete').toMatch(
      /\*\*Status \(V-884, 2026-08-18\): action complete\.\*\*/,
    );
  });

  it("10-verified-clean inventory framing pinned: '## Verified clean (explicitly checked)' + '**Scope-check enforcement**' + '**Plaintext credential leakage**' + '**Stripe webhook idempotency** — `processed_stripe_events` PK constraint resolves the check-then-insert race; replay protection via 5-minute timestamp tolerance + HMAC-SHA256 constant-time compare.' + '**Audit log injection**' + '**Account-scope leakage** — every resource lookup uses `(resourceId, accountId)` tuple in the repo layer; cross-account access returns null (treated as 404).' + '**Web session token security** — opaque sha256-hashed tokens (D-028); Bearer auth via header (not cookies → CSRF-immune); proper TTL + revocation.' + '**CSRF protection**' + '**User enumeration prevention** — auth-flow responses are shape-stable for unknown emails (always returns `{sent: true, ...}`).' + '**Cache version invalidation correctness**' + '**Multi-customer Stripe webhook events**' — pinned so the 10-verified-clean inventory + Stripe-PK-idempotency + 5-min-timestamp-tolerance + HMAC-SHA256 constant-time + (resourceId,accountId)-tuple + D-028 web-session-opaque-sha256 + CSRF-immune-Bearer-header commitment survives", () => {
    expect(body).toMatch(/## Verified clean \(explicitly checked\)/);
    expect(body).toMatch(/- \*\*Scope-check enforcement\*\*/);
    expect(body).toMatch(/- \*\*Plaintext credential leakage\*\*/);
    expect(body).toMatch(
      /- \*\*Stripe webhook idempotency\*\* — `processed_stripe_events` PK constraint resolves the check-then-insert race;/,
    );
    expect(body).toMatch(
      /replay protection via 5-minute timestamp tolerance \+ HMAC-SHA256 constant-time compare\./,
    );
    expect(body).toMatch(/- \*\*Audit log injection\*\*/);
    expect(body).toMatch(
      /- \*\*Account-scope leakage\*\* — every resource lookup uses `\(resourceId, accountId\)` tuple in the repo layer; cross-account access returns null \(treated as 404\)\./,
    );
    expect(body).toMatch(
      /- \*\*Web session token security\*\* — opaque sha256-hashed tokens \(D-028\); Bearer auth via header \(not cookies → CSRF-immune\); proper TTL \+ revocation\./,
    );
    expect(body).toMatch(/- \*\*CSRF protection\*\*/);
    expect(body).toMatch(
      /- \*\*User enumeration prevention\*\* — auth-flow responses are shape-stable for unknown emails \(always returns `\{sent: true, \.\.\.\}`\)\./,
    );
    expect(body).toMatch(/- \*\*Cache version invalidation correctness\*\*/);
    expect(body).toMatch(/- \*\*Multi-customer Stripe webhook events\*\*/);
  });

  it("V-498 closure-status table framing pinned: '## V-498 — closure status (2026-05-10)' + 'V-246-P0-001 | P0 | **CLOSED (V-247)**' + 'V-246-P1-001 | P1 | **CLOSED (V-248)**' + 'V-246-P1-002 | P1 | **DOCUMENTED**' + 'V-246-P1-003 | P1 | **DEFERRED (V-NNN)**' + 'V-246-P1-004 | P1 | **DEFERRED (V-NNN)**' + 'V-246-P2-003 | P2 | **PARTIAL CLOSURE (V-497)**' + '**Net status**: P0 closed; P1 closed where actionable pre-launch (2 of 4); 2 P1 deferred with explicit operational mitigations; 4 of 5 P2s deferred unchanged; 1 P2 (P2-003 Stripe rotation) gained a DR runbook entry under V-497.' — pinned so the V-498 closure-status (P0-closed-V-247 + P1-001-closed-V-248 + P1-002-documented + P1-003/004-deferred + P2-003-V-497-partial) + 2-of-4-P1-actionable commitment survives", () => {
    expect(body).toMatch(/## V-498 — closure status \(2026-05-10\)/);
    expect(body).toMatch(/V-246-P0-001\s+\|\s+P0\s+\|\s+\*\*CLOSED \(V-247\)\*\*/);
    expect(body).toMatch(/V-246-P1-001\s+\|\s+P1\s+\|\s+\*\*CLOSED \(V-248\)\*\*/);
    expect(body).toMatch(/V-246-P1-002\s+\|\s+P1\s+\|\s+\*\*DOCUMENTED\*\*/);
    expect(body).toMatch(/V-246-P1-003\s+\|\s+P1\s+\|\s+\*\*DEFERRED \(V-NNN\)\*\*/);
    expect(body).toMatch(/V-246-P1-004\s+\|\s+P1\s+\|\s+\*\*DEFERRED \(V-NNN\)\*\*/);
    expect(body).toMatch(/V-246-P2-003\s+\|\s+P2\s+\|\s+\*\*PARTIAL CLOSURE \(V-497\)\*\*/);
    expect(body).toMatch(
      /\*\*Net status\*\*: P0 closed; P1 closed where actionable pre-launch \(2 of 4\); 2 P1 deferred with explicit operational mitigations;/,
    );
    expect(body).toMatch(
      /4 of 5 P2s deferred unchanged; 1 P2 \(P2-003 Stripe rotation\) gained a DR runbook entry under V-497\./,
    );
  });

  it("V-498 delta-audit V-481/V-484/V-485/V-486/V-487/V-494 no-new-P0-P1 framing pinned: '## V-498 delta audit — what changed since 2026-05-06' + '### V-481 — granular API key scopes' + 'unit test matrix at `tests/unit/scope-check.test.ts` (41 cases)' + '### V-484 — audit-log filter extensions' + '### V-485 — per-tier feature gating' + 'TIER_FEATURES[tier][feature]' + '### V-494 — log + Sentry redaction' + 'pino is best-effort (developers may forget to nest fields under `body.*`); Sentry's recursive walker catches leakage that bypasses pino. Both layers must fail open for a secret to leak.' + '### V-486 — Postmark templates' + '### V-487 — NowPayments scaffold' + '`verifyNowpaymentsSignature` uses `timingSafeEqual` for the constant-time HMAC compare.' + 'Canonicalises JSON body (sorts keys at every level) before HMAC — protects against the `{\"a\":1,\"b\":2}` vs `{\"b\":2,\"a\":1}` variant attack.' + '### Net delta-audit verdict' + '**No new P0 or P1 findings introduced by V-481 → V-487.**' — pinned so the V-498-delta-audit + 6-slice-review (V-481+V-484+V-485+V-486+V-487+V-494) + 41-scope-check-cases + TIER_FEATURES-pure-boolean + pino+Sentry-both-must-fail-open + NowPayments-timingSafeEqual-canonicalised-JSON + no-new-P0-or-P1 commitment survives", () => {
    expect(body).toMatch(/## V-498 delta audit — what changed since 2026-05-06/);
    expect(body).toMatch(/### V-481 — granular API key scopes \(Track A wave 2\)/);
    expect(body).toMatch(/unit test matrix at `tests\/unit\/scope-check\.test\.ts` \(41 cases\)/);
    expect(body).toMatch(/### V-484 — audit-log filter extensions \(Track A wave 3\)/);
    expect(body).toMatch(/### V-485 — per-tier feature gating \(Track A wave 4\)/);
    expect(body).toMatch(
      /`requireTierFeature\(tier, feature\)` is a pure boolean lookup against `TIER_FEATURES\[tier\]\[feature\]`/,
    );
    expect(body).toMatch(/### V-494 — log \+ Sentry redaction \(Track C wave 4\)/);
    expect(body).toMatch(
      /pino is best-effort \(developers may forget to nest fields under `body\.\*`\); Sentry's recursive walker catches leakage that bypasses pino\. Both layers must fail open for a secret to leak\./,
    );
    expect(body).toMatch(/### V-486 — Postmark templates \(Track A wave 5\)/);
    expect(body).toMatch(/### V-487 — NowPayments scaffold \(Track A wave 6\)/);
    expect(body).toMatch(
      /`verifyNowpaymentsSignature` uses `timingSafeEqual` for the constant-time HMAC compare\./,
    );
    expect(body).toMatch(
      /Canonicalises JSON body \(sorts keys at every level\) before HMAC — protects against the `\{"a":1,"b":2\}` vs `\{"b":2,"a":1\}` variant attack\./,
    );
    expect(body).toMatch(/### Net delta-audit verdict/);
    expect(body).toMatch(/\*\*No new P0 or P1 findings introduced by V-481 → V-487\.\*\*/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
