// W786 — apps/docs reference/{errors,rate-limits,scopes}.md triplet
// parity guard. One-hundred-twelfth in the cross-SDK drift-guard
// series.
//
// /reference/ is the spec-level depth catalog. Drift to the problem-
// type / rate-limit / scope tables would let SDK consumers' types
// diverge from the canonical PROBLEM_TYPES / TIER_RATE_LIMIT_DEFAULTS
// / ApiKeyScopeSchema sources of truth.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ApiKeyScopeSchema } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ERR = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');
const RL = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/rate-limits.md');
const SCP = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/scopes.md');

describe('W786 docs reference/ triplet content parity', () => {
  it('all 3 reference files exist', () => {
    expect(existsSync(ERR)).toBe(true);
    expect(existsSync(RL)).toBe(true);
    expect(existsSync(SCP)).toBe(true);
  });

  // ─── reference/errors.md ──────────────────────────────────────

  it('CRITICAL errors.md frontmatter pinned.', () => {
    const p = read(ERR);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Error reference\n/,
    );
    expect(p).toMatch(
      /description: Every Driftstack RFC 9457 problem-type — what it means, the SDK error class for each language, status code, and whether to retry\./,
    );
  });

  it('CRITICAL RFC 9457 problem-details framing pinned. Matches W776 + W767 + W764 RFC 7807/9457 framing.', () => {
    const p = read(ERR);

    expect(p).toMatch(
      /Every error response from the Driftstack API is\s*\n?an \[RFC 9457 Problem Details\]\(https:\/\/www\.rfc-editor\.org\/rfc\/rfc9457\)/,
    );
    expect(p).toMatch(/JSON document\. The `type` URI uniquely identifies the error class;/);
  });

  it('CRITICAL errors mapping-table covers 25 problem-type rows. Drift to dropping any would let SDK consumers fail to handle an error class.', () => {
    const p = read(ERR);

    const slugs = [
      'errors.driftstack.dev/bad-request',
      'errors.driftstack.dev/validation-failed',
      'errors.driftstack.dev/unauthorized',
      'errors.driftstack.dev/invalid-key',
      'errors.driftstack.dev/revoked-key',
      'errors.driftstack.dev/expired-key',
      'errors.driftstack.dev/forbidden',
      'errors.driftstack.dev/mfa-step-up-required',
      'errors.driftstack.dev/email-not-verified',
      'errors.driftstack.dev/not-found',
      'errors.driftstack.dev/conflict',
      'errors.driftstack.dev/email-already-registered',
      'errors.driftstack.dev/invalid-credentials',
      'errors.driftstack.dev/invalid-auth-token',
      'errors.driftstack.dev/legal-acceptance-required',
      'errors.driftstack.dev/rate-limited',
      'errors.driftstack.dev/concurrency-limit',
      'errors.driftstack.dev/tier-limit',
      'errors.driftstack.dev/session-destroyed',
      'errors.driftstack.dev/session-timeout',
      'errors.driftstack.dev/driver-error',
      'errors.driftstack.dev/driver-not-integrated',
      'errors.driftstack.dev/feature-unavailable',
      'errors.driftstack.dev/internal',
    ];
    for (const slug of slugs) {
      expect(p, `slug ${slug}`).toMatch(new RegExp(`\\| \`${slug.replace(/\./g, '\\.')}\``));
    }
    // Special non-slug transport row.
    expect(p).toMatch(/\| \(network failure \/ parse error\)\s+\| 0/);
  });

  it("CRITICAL 3 retryable classes pinned — rate-limited + internal + transport. The '**yes**' bold-yes markers identify retryability.", () => {
    const p = read(ERR);

    expect(p).toMatch(
      /\| `errors\.driftstack\.dev\/rate-limited`\s+\| 429\s+.*\| \*\*yes\*\*\s+\|/,
    );
    expect(p).toMatch(/\| `errors\.driftstack\.dev\/internal`\s+\| 5xx\s+.*\| \*\*yes\*\*\s+\|/);
    expect(p).toMatch(/\| \(network failure \/ parse error\)\s+\| 0\s+.*\| \*\*yes\*\*\s+\|/);
  });

  it('CRITICAL isRetryable / is_retryable / IsRetryable cross-SDK predicate pinned. Matches W776 + W778 SDK error contracts.', () => {
    const p = read(ERR);

    expect(p).toMatch(/The SDKs all expose a public `isRetryable\(err\)` \/ `is_retryable` \//);
    expect(p).toMatch(/`IsRetryable` predicate that returns true for the three retryable/);
    expect(p).toMatch(/classes above\./);
  });

  it("CRITICAL why-some-5xx-aren't-retryable framing pinned. DriverError/DriverNotIntegrated/FeatureUnavailable/MfaStepUpRequired explained.", () => {
    const p = read(ERR);

    expect(p).toMatch(
      /`DriverError` \(502\) and `DriverNotIntegrated` \(503\) are\s*\n?\*\*not\*\* retryable because the underlying cause is structural/,
    );
    expect(p).toMatch(
      /`FeatureUnavailableError` \(503\) means an endpoint requires\s*\n?infrastructure not configured in this deployment/,
    );
    expect(p).toMatch(
      /`MfaStepUpRequiredError` \(403\) means the customer needs to\s*\n?prove fresh MFA before the request will succeed\./,
    );
  });

  it('CRITICAL errors source-of-truth pointers pinned — PROBLEM_TYPES + 3 SDK error files. Drift would lose canonical impl pointers.', () => {
    const p = read(ERR);

    expect(p).toMatch(/`packages\/api-types\/src\/problem\.ts` \(`PROBLEM_TYPES`\)/);
    expect(p).toMatch(/`packages\/sdk-typescript\/src\/errors\.ts`/);
    expect(p).toMatch(/`packages\/sdk-python\/src\/driftstack\/errors\.py`/);
    expect(p).toMatch(/`packages\/sdk-go\/errors\.go`/);
  });

  // ─── reference/rate-limits.md ─────────────────────────────────

  it('CRITICAL rate-limits.md frontmatter pinned.', () => {
    const p = read(RL);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Rate limits\n/);
    expect(p).toMatch(
      /description: Per-tier rate limit defaults — token-bucket capacity, refill rate, and what happens when you hit the cap\./,
    );
  });

  it('CRITICAL anti-abuse-not-pricing framing pinned. The "intentional anti-abuse caps (runaway scripts, accidental DoS), not the pricing meter. Pricing is concurrent-only per ADR-004" wording matches W754 + W769 + ADR-004 framing.', () => {
    const p = read(RL);

    expect(p).toMatch(
      /The limits are\s*\n?intentional anti-abuse caps \(runaway scripts, accidental DoS\),\s*\n?not the pricing meter\. Pricing is concurrent-only per ADR-004\./,
    );
  });

  it('CRITICAL bucket-key and account-scope framing pinned — each route selects one key; self/control consumes once; a team actor and distinct owner consume that same key and cost', () => {
    const p = read(RL);

    expect(p).toMatch(/Every authenticated request selects exactly one bucket key:/);
    expect(p).toMatch(
      /\*\*`global`\*\* — every authenticated `\/v1\/\*` call that doesn't\s*have a dedicated bucket below\./,
    );
    // BOTH session-creating calls draw on this bucket. routes/sessions.ts
    // registers `POST /v1/sessions` and `POST /v1/profiles/:id/launch` with
    // app.rateLimit('sessions:create'), so naming only the first published a
    // cap customers cannot reconcile with what a profile launch actually
    // spends.
    expect(p).toMatch(
      /\*\*`sessions:create`\*\* — the two session-creating calls,\s*`POST \/v1\/sessions` and `POST \/v1\/profiles\/:id\/launch`\./,
    );
    expect(p).not.toMatch(/\*\*`sessions:create`\*\* — `POST \/v1\/sessions` only/);
    expect(p).toMatch(
      /\*\*`agent_sessions:message`\*\* —\s*`POST \/v1\/agent-sessions\/:id\/message` only/,
    );
    expect(p).toMatch(
      /Each call uses only that named bucket key: a `POST \/v1\/sessions`\s*\n?uses `sessions:create` \(never `global`\)/,
    );
    expect(p).toMatch(
      /`POST \/v1\/agent-sessions\/:id\/message` uses\s*\n?`agent_sessions:message`\./,
    );
    expect(p).toMatch(/A self-scoped request consumes that bucket once for the caller\./);
    // Re-pinned when the control-key scope line gained its tier and shared-budget
    // detail. Asserted as the two CLAIMS rather than one exact sentence: the
    // capacity a control key draws on is the owner's own tier (V-711 fixed it
    // charging a free-tier floor and truncating a paid owner's live bucket), and
    // it shares one bucket with that account's API traffic. A single-sentence
    // regex would break on any rewording while proving nothing about either.
    expect(p).toMatch(/A per-session GUI control key consumes it once for the session owner/);
    expect(p).toMatch(/owner's own tier and active overrides/);
    expect(p).toMatch(/same bucket\*\* as that account's API traffic/);
    expect(p).toMatch(
      /A \*\*session or agent-session\*\* request made with `X-Driftstack-Account`\s*first consumes the actor's bucket, then consumes the \*\*same bucket key and\s*cost\*\* for the selected owner\./,
    );
    // The dual consume exists ONLY on the 35 session/agent-session routes:
    // consumeEffectiveOwnerRateLimit is imported by sessions.ts,
    // agent-sessions.ts, agent-sessions-livekit-token.ts and
    // agent-sessions-transport-report.ts and by nothing else, while ten route
    // modules honour the header. Claiming it for every team request would
    // promise an owner-aggregate cap that profiles/webhooks/audit/billing do
    // not enforce, so the page must state the boundary, not just the feature.
    expect(p).toMatch(
      /The second consume is scoped to the session and agent-session routes[\s\S]{0,120}?Other endpoints that honour\s*\n?`X-Driftstack-Account`[\s\S]{0,160}?currently charge the acting member\s*\n?only, so their owner-scoped reads and writes do not aggregate into one shared\s*\n?budget\./,
    );
    expect(p).toMatch(
      /The owner consume uses the owner's current tier and active staff override\.\s*\n?Authorization and role checks happen before the owner bucket is read\./,
    );
    // Negative pin — the retired dual-bucket fiction must not come back.
    expect(p).not.toMatch(/consumes from BOTH/i);
  });

  it('CRITICAL 8-tier rate-limit table pinned. Drift to per-tier capacity/refill values would mismatch TIER_RATE_LIMIT_DEFAULTS server-side enforcement.', () => {
    const p = read(RL);

    for (const tier of [
      'free',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(p, `tier ${tier}`).toMatch(new RegExp(`\\| \`${tier}\`\\s+\\|`));
    }

    // Key check pairs from the table.
    expect(p).toMatch(/\| `free`\s+\| 60\s+\| 1\s+\| 5\s+\| 1\/60/);
    expect(p).toMatch(/\| `enterprise`\s+\| 60,000\s+\| 1,000\s+\| 600\s+\| 10/);
  });

  it("CRITICAL 429 response shape + Retry-After header framing pinned. S36 2026-07-07 (fable-truth-audit): 'capped at 10s' — the real default cap in all three SDKs (TS maxDelayMs 10_000, Python max_delay_ms 10_000, Go MaxDelay 10s); the old 30s claim matched no SDK.", () => {
    const p = read(RL);

    expect(p).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/rate-limited"/);
    expect(p).toMatch(/"retry_after_seconds": 12/);
    expect(p).toMatch(
      /The standard `Retry-After` HTTP header carries the same value as\s*\n?`retry_after_seconds`\./,
    );
    expect(p).toMatch(
      /SDK clients honour it automatically with\s*\n?exponential backoff capped at 10s\./,
    );
    const ownerDenial = p.slice(
      p.indexOf("When a distinct selected owner's bucket is exhausted"),
      p.indexOf('## Per-account overrides'),
    );
    expect(ownerDenial).toMatch(
      /returns 429, but the problem remains generic \(`"Rate limit exceeded\."`\)/,
    );
    expect(ownerDenial).toMatch(
      /The generic body retains `retry_after_seconds`; among rate-limit headers,\s*\n?only `Retry-After` remains\./,
    );
    expect(ownerDenial).toMatch(
      /The owner's tier, capacity, remaining tokens,\s*\n?override, and reset policy are not disclosed\./,
    );
    expect(ownerDenial).toMatch(/The actor token was already\s*\n?consumed and is not refunded\./);
    expect(ownerDenial).not.toMatch(
      /owner(?:'s)? (?:tier|capacity|remaining tokens|override|reset policy) (?:is|are) (?:returned|included|reported|exposed)/i,
    );
    expect(p).not.toMatch(/capped at 30s/);
  });

  it("CRITICAL per-account-overrides framing pinned. The '/v1/admin/rate-limit-overrides + support@driftstack.dev workload-shape email' wording explains the escalation path.", () => {
    const p = read(RL);

    expect(p).toMatch(
      /Driftstack staff can configure per-account overrides via\s*\n?`\/v1\/admin\/rate-limit-overrides`\./,
    );
    expect(p).toMatch(
      /Email `support@driftstack\.dev` with workload shape \+\s*\n?expected steady-state RPS\./,
    );
  });

  it('CRITICAL GET /v1/account/rate-limits read-your-cap framing pinned. Matches W770 /api/account rate-limits SDK accessor. Shape: buckets is an ARRAY of {bucket_key, capacity, refill_per_second, source, override_expires_at} — matches the actual server response in apps/server/src/routes/account-rate-limits.ts (the previous "buckets is object" pin was source-of-truth-divergent).', () => {
    const p = read(RL);

    expect(p).toMatch(
      /`GET \/v1\/account\/rate-limits` returns the effective per-bucket\s*\n?config for your account, including any overrides:/,
    );
    expect(p).toMatch(/"tier": "api_builder",/);
    // Array shape — same as /api/account-rate-limits canonical docs.
    expect(p).toMatch(/"buckets": \[/);
    expect(p).toMatch(/"bucket_key": "global"/);
    expect(p).toMatch(/"bucket_key": "sessions:create"/);
    expect(p).toMatch(/"source": "tier_default"/);
    expect(p).toMatch(/"override_expires_at": null/);
  });

  it('CRITICAL response-header privacy pinned: actor policy headers remain useful; distinct-owner denial strips them and exposes only Retry-After', () => {
    const p = read(RL);

    expect(p).toMatch(/`x-ratelimit-bucket`/);
    expect(p).toMatch(/`x-ratelimit-limit`/);
    expect(p).toMatch(/`x-ratelimit-remaining`/);
    expect(p).toMatch(/`x-ratelimit-reset`/);
    expect(p).toMatch(
      /Allowed authenticated `\/v1\/\*` responses and actor-bucket denials carry\s*\n?four `x-ratelimit-\*` headers reflecting the actor bucket:/,
    );
    expect(p).toMatch(
      /For a distinct effective-owner denial, these policy headers are removed\s*\n?to avoid disclosing another account's capacity\. That response carries\s*\n?`Retry-After` only\./,
    );
    expect(p).toMatch(/`x-ratelimit-remaining=0` with `Retry-After`/);
    expect(p).toMatch(
      /On successful team requests, these values describe the actor bucket;\s*\n?the selected owner's remaining budget is intentionally not exposed\./,
    );
    expect(p).not.toMatch(/headers are emitted on every status code/i);
  });

  it('CRITICAL TIER_RATE_LIMIT_DEFAULTS source-of-truth pinned. Mirror sites: packages/api-types + apps/server/src/services/rate-limit.ts bucketConfigFor().', () => {
    const p = read(RL);

    expect(p).toMatch(/`packages\/api-types\/src\/common\.ts:TIER_RATE_LIMIT_DEFAULTS`/);
    expect(p).toMatch(/`apps\/server\/src\/services\/rate-limit\.ts`/);
    expect(p).toMatch(/`bucketConfigFor\(\)`/);
  });

  // ─── reference/scopes.md ──────────────────────────────────────

  it('CRITICAL scopes.md frontmatter pinned.', () => {
    const p = read(SCP);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: API key scopes\n/,
    );
    expect(p).toMatch(
      /description: Full reference of API key scopes — broad, granular, and the broad-satisfies-granular rule\./,
    );
  });

  it('CRITICAL 3-category framing pinned — Broad / Account-control / Granular. Matches W750 dashboard /api-keys V-481 granular-scope picker.', () => {
    const p = read(SCP);

    expect(p).toMatch(/\*\*Broad scopes\*\* — `read`, `write`, `admin`\./);
    expect(p).toMatch(
      /\*\*Account-control scopes\*\* — `account_owner`,\s*\n?\s+`driftstack_internal_admin`\./,
    );
    expect(p).toMatch(/\*\*Granular scopes \*\* — `verb:resource` syntax/);
  });

  it('V-1057 scope-catalog rows are derived from ApiKeyScopeSchema, so every scope a customer can hold has a row on the page. The roster was frozen as a hand-written list under a title whose count did not match it, beside a case-count for scope-check.test.ts that matches neither its arms nor its tests; a scope added next would have been documented nowhere and asserted by nothing. The figures are gone rather than corrected, because a corrected figure goes stale the same way — including the ones that would have sat in this sentence.', () => {
    const p = read(SCP);
    const scopes = ApiKeyScopeSchema.options;

    // A schema that failed to load would make the loop below vacuous.
    expect(scopes.length, 'scopes in ApiKeyScopeSchema').toBeGreaterThanOrEqual(19);

    for (const scope of scopes) {
      expect(p, `scope ${scope} has no row in reference/scopes.md`).toMatch(
        new RegExp(`\\| \`${scope}\``),
      );
    }
  });

  it("CRITICAL broad-satisfies-granular rule pinned. The 'A key with read satisfies every read:* granular scope ... The reverse is not true: a key with read:sessions does NOT satisfy read — narrow keys stay narrow. That\\'s the point of granular scoping' wording is the load-bearing scope-implication contract.", () => {
    const p = read(SCP);

    expect(p).toMatch(
      /A key with a broad scope \*\*satisfies\*\* any granular scope on\s*\n?the same verb:/,
    );
    expect(p).toMatch(/A key with `read` satisfies every `read:\*` granular scope/);
    expect(p).toMatch(
      /The reverse is \*\*not\*\* true: a key with `read:sessions` does\s*\n?NOT satisfy `read` — narrow keys stay narrow\./,
    );
  });

  it("CRITICAL 4-key-pattern ascii-table pinned. read / read:sessions / write / account_owner — each row demonstrates the implication chain. S36 2026-07-07 (fable-truth-audit): the write row's old 'can do: read, write' claim was FALSE — neither scope-predicate site (lib/errors-helpers.ts hasScope, services/auth.ts requireScope) lets `write` satisfy `read` or any `read:X`; only exact match, `read`, or `account_owner` do.", () => {
    const p = read(SCP);

    expect(p).toMatch(/key with: read\s+→ can do: read, plus every read:\*/);
    expect(p).toMatch(/key with: read:sessions\s+→ can do: read:sessions {2}\(only\)/);
    expect(p).toMatch(
      /key with: write\s+→ can do: write, plus every write:\* — but NO read:\* \(writes never imply reads\)/,
    );
    expect(p).toMatch(
      /key with: account_owner\s+→ can do: read, write, plus any read:\*\/write:\*\/admin:\*/,
    );
    // Negative pin — write-implies-read must not come back.
    expect(p).not.toMatch(/key with: write\s+→ can do: read/);
  });

  it("CRITICAL 403 RFC 9457 forbidden-shape framing pinned. The 'detail string names the exact scope required so you can mint a correctly-scoped replacement key' wording is the load-bearing error-recovery framing.", () => {
    const p = read(SCP);

    expect(p).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/forbidden"/);
    expect(p).toMatch(/"detail": "This action requires the \\"write:sessions\\" scope\."/);
    expect(p).toMatch(
      /The detail string names the exact scope required so you can\s*\n?mint a correctly-scoped replacement key/,
    );
  });

  it('CRITICAL 5-use-case picking-scopes guidance pinned. CI/test-runner + Production-application + Backup-automation + Webhook-signing-only + Dashboard. Drift would lose canonical scope-pattern advice.', () => {
    const p = read(SCP);

    expect(p).toMatch(/\*\*CI \/ test runner:\*\* `read:sessions` \+ `write:sessions`/);
    expect(p).toMatch(/\*\*Production application:\*\* `read` \+ `write`/);
    expect(p).toMatch(/\*\*Backup automation:\*\* `read` \+ `read:audit`/);
    expect(p).toMatch(/\*\*Webhook signing-only key:\*\* mint a key with NO scopes/);
    expect(p).toMatch(/\*\*Dashboard \/ customer self-service:\*\* `account_owner`/);
  });

  it('CRITICAL ApiKeyScopeSchema + requireScope source-of-truth pinned. 2 server-side call sites + 41-case unit test.', () => {
    const p = read(SCP);

    expect(p).toMatch(/`packages\/api-types\/src\/common\.ts:ApiKeyScopeSchema`/);
    expect(p).toMatch(
      /mirrored at two server-side call\s*\n?sites \(`apps\/server\/src\/lib\/errors-helpers\.ts` \+\s*\n?`apps\/server\/src\/services\/auth\.ts`\)/,
    );
    expect(p).toMatch(
      /41-case unit test at\s*\n?`apps\/server\/tests\/unit\/scope-check\.test\.ts`/,
    );
  });

  it('CRITICAL gui_control scope locked-decision-L-001 framing pinned. V-788 — the claim this used to freeze (customer keys never carry gui_control; only enterprise self-hosted GUI keys do) was FALSE: ELEVATED_SCOPES withholds only admin + driftstack_internal_admin, so any account_owner on an apiAccess tier can mint a key carrying it. The corrected text is pinned here and kept honest by gui-control-is-a-scope-boundary-not-a-tier-one.test.ts, which derives the restriction from the code.', () => {
    const p = read(SCP);

    expect(p).toMatch(
      /\| `gui_control`\s+\| special\s+\| Manual-control plane \(`tap_at`, `type_focused`\)\. Intended for the self-hosted GUI workflow \(locked-decision L-001\); it is never granted unless a mint request asks for it, but no tier or deployment check restricts who may ask\./,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-reference-triplet-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
