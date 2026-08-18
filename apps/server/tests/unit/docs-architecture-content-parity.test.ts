// W548.A — drift guard for /docs/architecture.md.
// Living architecture doc. Drift here either misrepresents the
// 6-layer system shape (would mislead future contributors), changes
// the 11-route public-API inventory (would diverge from the actual
// Fastify route registry), drops the D-020/D-025 auth-cache-version
// pattern (would erode the cache-invalidation contract), or changes
// the 4-postgres-table domain grouping (would conflate persistence
// boundaries).
//
//   • Last refresh 2026-05-03 (V-087 sync + V-109 catch-up).
//   • 6 layers: Routes + Services + Drivers + DB + Middleware + Lib.
//   • 11-surface public API table (Sessions + API keys + Usage +
//     Profiles + Auth flow + Billing + Outbound webhooks + Inbound
//     Stripe + Admin + Legal + Health).
//   • 2-auth-surface: API keys (Bearer, 30s Redis cache) + Web
//     sessions (opaque sha256, 30d TTL).
//   • Postgres-17 Neon EU + Redis-7 Upstash EU + Cloudflare R2.
//   • Driver abstraction: mock (default) + webkit (throws
//     DriverNotIntegratedError until fork Phase 2 closes).
//   • Tier model ADR-004 (Manual + API ladders, concurrent-only
//     metering).
//   • V-202c/d AccountLifecycleService + ScheduledJobsService.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/architecture.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W548.A /docs/architecture.md content parity', () => {
  const body = read(LIB);

  it("Header + V-087/V-109 last-refresh framing pinned: '# Driftstack API — Architecture' + 'Living document. Reflects the state on the date noted below; updated alongside V-NNN entries that change system shape.' + '**Last refresh:** 2026-05-03 (V-087 full sync covering V-079..V-086; V-109 catch-up adding V-099 customer-dashboard workspace + V-100 admin force-actions). Prior baseline was Phase-1 minimal and significantly out of date.' — pinned so the living-document + V-087-full-sync-V-079..V-086 + V-109-catch-up-V-099-customer-dashboard+V-100-admin-force-actions + Phase-1-baseline-out-of-date commitment survives", () => {
    expect(body).toMatch(/^# Driftstack API — Architecture$/m);
    expect(body).toMatch(
      /> Living document\. Reflects the state on the date noted below; updated alongside V-NNN entries that change system shape\./,
    );
    expect(body).toMatch(
      /\*\*Last refresh:\*\* 2026-05-03 \(V-087 full sync covering V-079\.\.V-086;/,
    );
    expect(body).toMatch(
      /V-109 catch-up adding V-099 customer-dashboard workspace \+ V-100 admin force-actions\)\./,
    );
    expect(body).toMatch(/Prior baseline was Phase-1 minimal and significantly out of date\./);
  });

  it("6-layer + Drivers + DB + Middleware + Lib + Schemas framing pinned: '## Layers' + '**Routes** (`apps/server/src/routes/`) — Fastify handlers, one file per resource.' + '**Services** (`apps/server/src/services/`) — Business logic + orchestration.' + '**Drivers** (`apps/server/src/drivers/`) — Abstraction over the WebKit substrate. Two implementations: `mock` (in-memory, deterministic, fast-forwardable latency) and `webkit` (real fork, scaffolded but not yet integrated — throws `DriverNotIntegratedError` until the fork hands off).' + '**DB layer** (`apps/server/src/db/`) — Drizzle ORM.' + '**Middleware** (`apps/server/src/middleware/`) — `request-id`, `auth` (API key extraction → AccountContext), `rate-limit` (Redis token bucket per account+bucket), `error-handler` (RFC 7807 problem+json formatter).' + '**Lib** (`apps/server/src/lib/`) — Cross-cutting utilities' + '**Schemas** (`apps/server/src/schemas/`) — Server-internal Zod shapes that aren't part of the public contract. Public-contract schemas live in `packages/api-types/`.' — pinned so the 6-layer separation + mock-vs-webkit-DriverNotIntegratedError + RFC-7807 problem+json + server-internal-vs-public-api-types commitment survives", () => {
    expect(body).toMatch(/## Layers/);
    expect(body).toMatch(
      /- \*\*Routes\*\* \(`apps\/server\/src\/routes\/`\) — Fastify handlers, one file per resource\./,
    );
    expect(body).toMatch(
      /- \*\*Services\*\* \(`apps\/server\/src\/services\/`\) — Business logic \+ orchestration\./,
    );
    expect(body).toMatch(
      /- \*\*Drivers\*\* \(`apps\/server\/src\/drivers\/`\) — Abstraction over the WebKit substrate\./,
    );
    expect(body).toMatch(
      /Two implementations: `mock` \(in-memory, deterministic, fast-forwardable latency\) and `webkit`/,
    );
    expect(body).toMatch(
      /\(real fork, scaffolded but not yet integrated — throws `DriverNotIntegratedError` until the fork hands off\)\./,
    );
    expect(body).toMatch(/- \*\*DB layer\*\* \(`apps\/server\/src\/db\/`\) — Drizzle ORM\./);
    expect(body).toMatch(
      /- \*\*Middleware\*\* \(`apps\/server\/src\/middleware\/`\) — `request-id`, `auth` \(API key extraction → AccountContext\),/,
    );
    expect(body).toMatch(
      /`rate-limit` \(Redis token bucket per account\+bucket\), `error-handler` \(RFC 7807 problem\+json formatter\)\./,
    );
    expect(body).toMatch(/- \*\*Lib\*\* \(`apps\/server\/src\/lib\/`\) — Cross-cutting utilities/);
    expect(body).toMatch(
      /- \*\*Schemas\*\* \(`apps\/server\/src\/schemas\/`\) — Server-internal Zod shapes that aren't part of the public contract\./,
    );
    expect(body).toMatch(/Public-contract schemas live in `packages\/api-types\/`\./);
  });

  it("11-surface public API table + auth column framing pinned: '## Public API surfaces' + 'Sessions | `POST /v1/sessions`' + 'API keys' + 'Usage' + 'Profiles' + 'Auth flow' + 'Billing' + 'Outbound webhooks' + 'Inbound Stripe' + 'Admin' + 'Legal' + 'Health / readiness' + 'Stripe-Signature header IS the auth' + 'Bearer (admin scope)' — pinned so the 11-surface inventory + auth-mapping (Bearer / Bearer-admin / Public / Stripe-Signature) + V-079+V-080+V-081+V-082+V-100 anchor commitment survives", () => {
    expect(body).toMatch(/## Public API surfaces/);
    expect(body).toMatch(/Sessions\s+\|\s+`POST \/v1\/sessions`/);
    expect(body).toMatch(/API keys\s+\|\s+`POST \/v1\/api-keys`/);
    expect(body).toMatch(/Usage\s+\|\s+`GET \/v1\/usage`/);
    expect(body).toMatch(/Profiles\s+\|\s+`POST\/GET \/v1\/profiles`/);
    expect(body).toMatch(/Auth flow\s+\|/);
    expect(body).toMatch(
      /Billing\s+\|\s+`POST \/v1\/billing\/\{checkout-session,trial-pack,portal-session\}`/,
    );
    expect(body).toMatch(/Outbound webhooks\s+\|/);
    expect(body).toMatch(/Inbound Stripe\s+\|\s+`POST \/v1\/webhooks\/stripe`/);
    expect(body).toMatch(/\*\*Stripe-Signature header IS the auth\*\*/);
    expect(body).toMatch(/Admin\s+\|/);
    expect(body).toMatch(/Legal\s+\|/);
    expect(body).toMatch(/Health \/ readiness\s+\|/);
    expect(body).toMatch(/Bearer \(admin scope\)/);
  });

  it("2-auth-surface API-keys + Web-sessions framing pinned: '## Auth model' + 'Two distinct auth surfaces, separated by audience' + '**API keys** — for SDK consumers (programmatic). Long-lived `ds_<env>_<base32>` tokens, scrypt-hashed at rest (`api_keys.key_hash`), 16-char prefix indexed for O(1) lookup.' + 'Cached as `AccountContext` in Redis with sha256 cache key, 30-second TTL, account-version invalidation on tier-change / suspend / revoke (D-020 + D-025 cache invalidation pattern).' + '**Web sessions** — for browser dashboard / admin panel. Opaque 32-byte URL-safe random tokens, sha256-hashed at rest (`web_sessions.token_hash`), revocable by `revoked_at` set, 30-day default TTL.' + 'Server-side validation only — no JWT secrets to rotate.' — pinned so the API-keys-ds_env_base32 + scrypt-hashed + 16-char-prefix + 30s-Redis-TTL + D-020+D-025-account-version + Web-sessions-opaque-sha256-32-byte + 30d-TTL + server-side-only-no-JWT-rotate commitment survives", () => {
    expect(body).toMatch(/## Auth model/);
    expect(body).toMatch(/Two distinct auth surfaces, separated by audience:/);
    expect(body).toMatch(/\*\*API keys\*\* — for SDK consumers \(programmatic\)\./);
    expect(body).toMatch(
      /Long-lived `ds_<env>_<base32>` tokens, scrypt-hashed at rest \(`api_keys\.key_hash`\),/,
    );
    expect(body).toMatch(/16-char prefix indexed for O\(1\) lookup\./);
    expect(body).toMatch(
      /Cached as `AccountContext` in Redis with sha256 cache key, 30-second TTL,/,
    );
    expect(body).toMatch(
      /account-version invalidation on tier-change \/ suspend \/ revoke \(D-020 \+ D-025 cache invalidation pattern\)\./,
    );
    expect(body).toMatch(/\*\*Web sessions\*\* — for browser dashboard \/ admin panel\./);
    expect(body).toMatch(
      /Opaque 32-byte URL-safe random tokens, sha256-hashed at rest \(`web_sessions\.token_hash`\),/,
    );
    expect(body).toMatch(/revocable by `revoked_at` set, 30-day default TTL\./);
    expect(body).toMatch(/Server-side validation only — no JWT secrets to rotate\./);
  });

  it("Postgres-Neon-EU + Redis-Upstash-EU + R2 + Stripe-Signature webhook lifecycle framing pinned: '## Persistence' + '**Postgres 17** (Neon EU Frankfurt) holds durable state.' + '**Redis 7** (Upstash EU Frankfurt) holds ephemeral state' + '**Cloudflare R2** (EU jurisdiction) holds session recordings. Optional — disabled when not configured at boot, readiness probe skips the R2 check.' + '## Request lifecycle (Stripe inbound webhook)' + 'missing `Stripe-Signature` header → 401' + 'signature verification (HMAC-SHA256 over `<timestamp>.<raw body>` with replay tolerance 5 min)' + 'always replies 200 to a verified, parseable event (even on duplicate or ignored event types) to prevent Stripe re-delivery loops.' — pinned so the Neon-EU-Frankfurt + Upstash-EU-Frankfurt + R2-EU-optional + HMAC-SHA256-over-timestamp.rawbody + 5-min-replay-tolerance + always-200-prevent-redelivery-loop commitment survives", () => {
    expect(body).toMatch(/## Persistence/);
    expect(body).toMatch(/\*\*Postgres 17\*\* \(Neon EU Frankfurt\) holds durable state\./);
    expect(body).toMatch(/\*\*Redis 7\*\* \(Upstash EU Frankfurt\) holds ephemeral state:/);
    expect(body).toMatch(/\*\*Cloudflare R2\*\* \(EU jurisdiction\) holds session recordings\./);
    expect(body).toMatch(
      /Optional — disabled when not configured at boot, readiness probe skips the R2 check\./,
    );
    expect(body).toMatch(/## Request lifecycle \(Stripe inbound webhook\)/);
    expect(body).toMatch(/missing `Stripe-Signature` header → 401/);
    expect(body).toMatch(
      /signature verification \(HMAC-SHA256 over `<timestamp>\.<raw body>` with replay tolerance 5 min\)/,
    );
    // V-792 — this used to freeze "Always replies 200 to a verified, parseable
    // event … to prevent Stripe re-delivery loops", with no mention of the
    // deliberate 500. routes/webhooks-stripe.ts:102-113 catches a transient infra
    // error, bumps handler_transient_error and RETHROWS, and says so in its own
    // comment: "The one exception is a transient infra error above, which we
    // deliberately let 500 (C5)". The sibling pin
    // routes-webhooks-stripe-content-parity.test.ts:99-104 froze that truth, so
    // two pins in this repo asserted opposite things and both were green. An
    // operator triaging Stripe 500s reads this doc and treats a working retry
    // mechanism as an outage.
    expect(body).toMatch(
      /Replies 200 to a verified, parseable event that was processed — including duplicates and ignored event types/,
    );
    expect(body).toMatch(
      /The one exception is a transient infrastructure error \(C5\): `handle\(\)` rethrows those/,
    );
    expect(body).toMatch(
      /A permanent handler error is swallowed and recorded inside dispatch, so it still returns 200\./,
    );
    expect(body, 'the unqualified always-200 claim must not return').not.toMatch(
      /Always replies 200 to a verified, parseable event/,
    );
  });

  it("V-202c AccountLifecycleService + V-202d ScheduledJobsService framing pinned: '## Lifecycle event dispatcher (V-202c / V-202b)' + 'Customer-facing events that pair an audit-log entry with a transactional email go through `AccountLifecycleService`' + 'Account row lookup (`AccountLifecycleRepo.findForLifecycle`)' + 'Audit-log emit (when applicable for the event kind) via `AccountAuditService.record`.' + 'Email-preference opt-out check via `EmailPreferencesService.shouldSend`.' + 'Atomic dedup mark (when applicable) — e.g. `accounts.first_failure_email_sent_at` for `session.failed.first`.' + '`EmailService` send.' + 'Best-effort by contract: errors during dispatch are caught + logged warn, never propagate to the caller.' + 'session.failed.first' + 'session.success.first' + 'subscription.tier_changed' + 'subscription.renewal_reminder' + '## Scheduled jobs (V-202d)' + '`SELECT … FOR UPDATE SKIP LOCKED` in a CTE → `UPDATE … RETURNING`' + 'auth_tokens.sweep' — pinned so the V-202c/V-202b 5-step-fanout + best-effort-never-propagate + 4-event-kind union + V-202d FOR-UPDATE-SKIP-LOCKED atomic claim + registered-handler list survives. (Trial-pack kinds + trial_pack.expired handler removed with the dead trial_pack lifecycle.)", () => {
    expect(body).toMatch(/## Lifecycle event dispatcher \(V-202c \/ V-202b\)/);
    expect(body).toMatch(
      /Customer-facing events that pair an audit-log entry with a transactional email go through `AccountLifecycleService`/,
    );
    expect(body).toMatch(/1\. Account row lookup \(`AccountLifecycleRepo\.findForLifecycle`\)/);
    expect(body).toMatch(
      /2\. Audit-log emit \(when applicable for the event kind\) via `AccountAuditService\.record`\./,
    );
    expect(body).toMatch(
      /3\. Email-preference opt-out check via `EmailPreferencesService\.shouldSend`\./,
    );
    expect(body).toMatch(
      /4\. Atomic dedup mark \(when applicable\) — e\.g\. `accounts\.first_failure_email_sent_at` for `session\.failed\.first`\./,
    );
    expect(body).toMatch(/5\. `EmailService` send\./);
    expect(body).toMatch(
      /Best-effort by contract: errors during dispatch are caught \+ logged warn, never propagate to the caller\./,
    );
    expect(body).toMatch(/`session\.failed\.first`/);
    expect(body).toMatch(/`session\.success\.first`/);
    expect(body).toMatch(/`subscription\.tier_changed`/);
    expect(body).toMatch(/`subscription\.renewal_reminder`/);
    // Trial-pack kinds removed with the dead trial_pack lifecycle.
    expect(body).not.toMatch(/`subscription\.trial_pack_purchased`/);
    expect(body).not.toMatch(/`subscription\.trial_pack_expired`/);
    expect(body).toMatch(/## Scheduled jobs \(V-202d\)/);
    expect(body).toMatch(/`SELECT … FOR UPDATE SKIP LOCKED` in a CTE → `UPDATE … RETURNING`/);
    expect(body).toMatch(/Registered handlers today: `auth_tokens\.sweep`/);
    expect(body).not.toMatch(/First registered handler: `trial_pack\.expired`/);
  });

  it("Driver interface + ADR-004 tier model + D-NNN cross-reference framing pinned: '## Driver abstraction' + 'interface Driver {' + 'createSession(spec: SessionSpec): Promise<DriverSession>;' + 'navigate(sessionId: string, url: string, opts?: NavigateOpts)' + 'interact(sessionId: string, action: InteractionAction)' + 'capture(sessionId: string, kind: CaptureKind)' + 'destroy(sessionId: string): Promise<void>;' + '## Tier model (ADR-004)' + 'Two ladders (Manual + API), concurrent-only metering on paid tiers, hours metering only on the trial pack via `accounts.trial_pack_credit_cents` decrement.' + '`TIER_CONCURRENT_SESSION_LIMITS`, `PROFILES_PER_TIER`' + '**D-019 / ADR-004** — Two-ladder pricing + concurrent-only metering.' + '**D-027 / ADR-002** — Stripe-only payment rail at launch.' + '**ADR-003** — Paid trial pack ($2.99 / 14 days / $0.18-per-hour decrement) replaces a free tier.' + '**D-028** — Web sessions are opaque sha256-hashed tokens (not JWT).' + '**D-030** — Inbound Stripe webhook idempotency via `processed_stripe_events` PK.' + '**ADR-001** — Hetzner for control-plane hosting.' + 'Long-form ADRs live under `docs/adr/`. Short D-NNN entries with autonomy levels live in `docs/decisions.md`.' — pinned so the Driver-7-method-interface + ADR-004 two-ladder + ADR-002 Stripe-only + ADR-003 trial-pack-$2.99/14d/$0.18/h + D-028 opaque-sha256 + D-030 processed_stripe_events-PK + ADR-001 Hetzner + ADR-vs-D-NNN naming commitment survives", () => {
    expect(body).toMatch(/## Driver abstraction/);
    expect(body).toMatch(/interface Driver \{/);
    expect(body).toMatch(/createSession\(spec: SessionSpec\): Promise<DriverSession>;/);
    expect(body).toMatch(/navigate\(sessionId: string, url: string, opts\?: NavigateOpts\)/);
    expect(body).toMatch(/interact\(sessionId: string, action: InteractionAction\)/);
    expect(body).toMatch(/capture\(sessionId: string, kind: CaptureKind\)/);
    expect(body).toMatch(/destroy\(sessionId: string\): Promise<void>;/);
    expect(body).toMatch(/## Tier model \(ADR-004\)/);
    expect(body).toMatch(/Two ladders \(Manual \+ API\), concurrent-only metering on paid tiers,/);
    expect(body).toMatch(
      /hours metering only on the trial pack via `accounts\.trial_pack_credit_cents` decrement\./,
    );
    expect(body).toMatch(/`TIER_CONCURRENT_SESSION_LIMITS`, `PROFILES_PER_TIER`/);
    expect(body).toMatch(
      /\*\*D-019 \/ ADR-004\*\* — Two-ladder pricing \+ concurrent-only metering\./,
    );
    expect(body).toMatch(/\*\*D-027 \/ ADR-002\*\* — Stripe-only payment rail at launch\./);
    expect(body).toMatch(
      /\*\*ADR-003\*\* — Paid trial pack \(\$2\.99 \/ 14 days \/ \$0\.18-per-hour decrement\) replaces a free tier\./,
    );
    expect(body).toMatch(
      /\*\*D-028\*\* — Web sessions are opaque sha256-hashed tokens \(not JWT\)\./,
    );
    expect(body).toMatch(
      /\*\*D-030\*\* — Inbound Stripe webhook idempotency via `processed_stripe_events` PK\./,
    );
    expect(body).toMatch(/\*\*ADR-001\*\* — Hetzner for control-plane hosting\./);
    expect(body).toMatch(
      /Long-form ADRs live under `docs\/adr\/`\. Short D-NNN entries with autonomy levels live in `docs\/decisions\.md`\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('CRITICAL the documented LifecycleEvent kinds are DERIVED from the union, not remembered. V-805 found the list documenting four kinds while six were wired — the two billing.* ones were absent, including billing.payment_failed, which is deliberately excluded from OptOutableEmailEventSchema so a customer cannot mute a failed-payment notice. That is precisely the kind a reader needs, and a hand-maintained list is the shape V-794 ratchets against.', () => {
    const service = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/account-lifecycle.ts'),
      'utf8',
    );
    const wired = new Set(
      [...service.matchAll(/\bkind:\s*'([a-z]+\.[a-z_.]+)'/g)].map((m) => m[1]!),
    );

    // Vacuity: an empty union would make the subset check pass against nothing.
    expect(wired.size, 'lifecycle kinds found in the union').toBeGreaterThanOrEqual(6);

    const documented = new Set(
      [...body.matchAll(/^- `([a-z]+\.[a-z_.]+)` — /gm)].map((m) => m[1]!),
    );
    const missing = [...wired].filter((k) => !documented.has(k)).sort();
    expect(
      missing,
      'lifecycle kinds wired in account-lifecycle.ts but absent from the architecture doc:',
    ).toEqual([]);
  });
});
