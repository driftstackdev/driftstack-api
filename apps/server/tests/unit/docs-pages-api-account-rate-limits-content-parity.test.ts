// W788 — apps/docs api/account-rate-limits.md content parity. One-
// hundred-fourteenth in the cross-SDK drift-guard series. Closes the
// apps/docs page sweep — every page has a parity guard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account-rate-limits.md');

describe('W788 docs /api/account-rate-limits content parity', () => {
  it('api/account-rate-limits.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Account rate limits\n/,
    );
    expect(p).toMatch(
      /description: Read your account's effective per-bucket rate-limit config — tier defaults plus any active admin overrides\./,
    );
  });

  it("CRITICAL effective-config framing pinned. The 'The /v1/account/rate-limits endpoint exposes the **effective** config your account is hitting right now — tier defaults merged with any active admin overrides' wording matches W786 reference/rate-limits + W770 /api/account rate_limits accessor.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The\s*\n?`\/v1\/account\/rate-limits` endpoint exposes the \*\*effective\*\* config\s*\n?your account is hitting right now — tier defaults merged with any\s*\n?active admin overrides\./,
    );
  });

  it("CRITICAL cross-reference to /reference/rate-limits pinned. The 'For the broader explanation of how rate limits work + the per-tier defaults table, see [/reference/rate-limits]' wording threads the W786 reference cross-link.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /For the broader explanation of how rate limits work \+ the per-tier\s*\n?defaults table, see \[\/reference\/rate-limits\]\(\/reference\/rate-limits\/\)\./,
    );
  });

  it('CRITICAL 4 bucket-key framing pinned — global + sessions:create + agent_sessions:message + agent_sessions:input_event. GET /v1/account/rate-limits returns all four (TIER_RATE_LIMIT_DEFAULTS has four buckets per tier); drift to dropping one would understate the buckets a customer can hit. Discrete small pins (no long \\s*\\n? chains).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Four bucket keys exist: `global`/);
    // The intro prose and the bucket table further down describe the SAME
    // bucket, so they must name the same routes. This pin said "only" while the
    // table already named both calls, which let the page contradict itself —
    // routes/sessions.ts registers app.rateLimit('sessions:create') on both
    // POST /v1/sessions and POST /v1/profiles/:id/launch.
    expect(p).toMatch(
      /`sessions:create`\s*\n?\(`POST \/v1\/sessions` and `POST \/v1\/profiles\/:id\/launch`/,
    );
    expect(p).not.toMatch(/`sessions:create`\s*\n?\(`POST \/v1\/sessions` only/);
    expect(p).toMatch(/`agent_sessions:message`\s*\n?\(`POST \/v1\/agent-sessions\/:id\/message`/);
    expect(p).toMatch(
      /`agent_sessions:input_event`\s*\n?\(`POST \/v1\/agent-sessions\/:id\/input-event`/,
    );
  });

  it('CRITICAL response shape — tier + buckets[] with bucket_key/capacity/refill_per_second/source/override_expires_at fields pinned. Drift to a different shape would break SDK consumer typings.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"tier": "api_builder"/);
    expect(p).toMatch(/"buckets": \[/);
    expect(p).toMatch(/"bucket_key": "global"/);
    expect(p).toMatch(/"capacity": 1800/);
    expect(p).toMatch(/"refill_per_second": 30/);
    expect(p).toMatch(/"source": "tier_default"/);
    expect(p).toMatch(/"override_expires_at": null/);
  });

  it('CRITICAL source 2-enum tier_default | override + override_expires_at framing pinned. Drift would lose discrimination between defaults vs admin-bumped buckets.', () => {
    const p = read(PAGE);

    // Override example.
    expect(p).toMatch(/"source": "override"/);
    expect(p).toMatch(/"override_expires_at": "2026-06-15T12:00:00Z"/);
  });

  it("CRITICAL override-expires-revert-to-tier-default framing pinned. The 'After the override expires, subsequent reads return the tier-default row again. The override doesn\\'t disappear from the admin\\'s audit trail — only from the calling account\\'s effective config' wording is the load-bearing lifecycle contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /After the override expires, subsequent reads return the\s*\n?tier-default row again\. The override doesn't disappear from the\s*\n?admin's audit trail — only from the calling account's effective\s*\n?config\./,
    );
  });

  it("CRITICAL bucket-reference table + single-bucket framing pinned. S36 2026-07-07 (fable-truth-audit): the old 'consumes from BOTH buckets' wording was FALSE — POST /v1/sessions registers exactly one rate-limit preHandler, app.rateLimit('sessions:create') (routes/sessions.ts), and the middleware consumes only the single named bucket; `global` is never drained by session-create. Doc now states the each-call-drains-exactly-one-bucket reality.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\| `global`\s+\| Every authenticated `\/v1\/\*` without a dedicated bucket \| Coarse anti-abuse cap/,
    );
    expect(p).toMatch(
      /\| `sessions:create`\s+\| `POST \/v1\/sessions` and `POST \/v1\/profiles\/:id\/launch` \| Lower cap because session creation is the most expensive op/,
    );
    expect(p).toMatch(
      /Each call drains exactly one bucket\. A `POST \/v1\/sessions` consumes\s*\n?only from `sessions:create` — it never touches `global` — and\s*\n?hitting that bucket's cap returns 429\./,
    );
    // Negative pin — the retired dual-bucket fiction must not come back.
    expect(p).not.toMatch(/consumes from BOTH/i);
  });

  it("CRITICAL admin-override 3-field shape pinned — capacity + refill_per_second + expires_at + reason (admin-only). The 'reason — admin-side audit string (not exposed on the customer endpoint)' wording is the load-bearing privacy boundary.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`capacity` and `refill_per_second` — the new ceiling/);
    expect(p).toMatch(
      /`expires_at` — when the override automatically reverts to tier\s*\n?\s+default/,
    );
    expect(p).toMatch(
      /`reason` — admin-side audit string \(not exposed on the customer\s*\n?\s+endpoint\)/,
    );
  });

  it("CRITICAL high-throughput-customer escalation pinned. The 'Customers needing legitimate high-throughput workloads (Enterprise, agencies running scraping jobs across many domains) request overrides via support@driftstack.dev with workload shape + expected steady-state RPS. Admins evaluate, set the override via /v1/admin/rate-limit-overrides, and notify the customer' wording matches W786 reference/rate-limits per-account-overrides framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Customers needing legitimate high-throughput workloads \(Enterprise,\s*\n?agencies running scraping jobs across many domains\) request\s*\n?overrides via `support@driftstack\.dev` with workload shape \+\s*\n?expected steady-state RPS\./,
    );
    expect(p).toMatch(
      /Admins evaluate, set the override via\s*\n?`\/v1\/admin\/rate-limit-overrides`, and notify the customer\./,
    );
  });

  it("CRITICAL Customer-dashboard-surface framing pinned — TRUTHFUL version, W576 edition. History: the original pin claimed '/usage renders the same data visually' when no such section existed (source-divergent lie → fixed to 'not yet'); W576 BUILT the section, so the claim flipped true again. To keep the doc honest in BOTH directions, this pin now also asserts the dashboard source actually contains the rate-limits section + fetch — if the section is ever removed, this fails and the doc must flip back.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `\/usage` page on the dashboard renders this endpoint's data in\s*\n?its "Rate limits" card/,
    );
    expect(p).toMatch(/tier default vs staff override/);
    expect(p).toMatch(/The endpoint remains available for SDK \/ `curl`\s*\n?reads\./);

    // Source-of-truth coupling: the dashboard section + fetch must exist.
    const usagePage = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro'));
    expect(usagePage).toMatch(/data-section="rate-limits"/);
    expect(usagePage).toMatch(/\/v1\/account\/rate-limits/);
    expect(usagePage).toMatch(/data-rate-limit-rows/);
  });

  it('CRITICAL x-ratelimit-* response headers documented. Drift would orphan SDK consumers from the per-response capacity/remaining/reset surface emitted by middleware/rate-limit.ts. Pins all 4 headers + the emitted-on-every-status invariant.', () => {
    const p = read(PAGE);

    // Header names matching middleware/rate-limit.ts lines 62-65.
    expect(p).toMatch(/`x-ratelimit-bucket`/);
    expect(p).toMatch(/`x-ratelimit-limit`/);
    expect(p).toMatch(/`x-ratelimit-remaining`/);
    expect(p).toMatch(/`x-ratelimit-reset`/);
    // W561 — IETF draft names documented alongside, incl. the relative-reset
    // semantic (ratelimit-reset = seconds-from-now, not a timestamp).
    expect(p).toMatch(/`ratelimit-limit` \/ `ratelimit-remaining` \/\s*\n?`ratelimit-reset`/);
    expect(p).toMatch(/`ratelimit-reset` is \*\*relative\*\* seconds-from-now/);
    // Invariant: headers are emitted regardless of status code so
    // retry logic can read them after a 4xx/429.
    expect(p).toMatch(/headers\s*\n?are emitted regardless of HTTP status/);
    // The combine-with-Retry-After-on-429 pattern.
    expect(p).toMatch(
      /combine\s*\n?`x-ratelimit-remaining=0` \+ `Retry-After` to drive a back-off/,
    );
  });

  it('CRITICAL 429 response shape pinned matching the live RateLimitedError (errors.ts): title "Too Many Requests" + body fields type/title/status/detail/retry_after_seconds ONLY. The bucket is NOT a body field — it is the `x-ratelimit-bucket` response header (rate-limit.ts) — so the doc must NOT show "bucket" in the JSON body. Matches reference/errors.md + reference/rate-limits.md rate-limited contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/rate-limited"/);
    expect(p).toMatch(/"title": "Too Many Requests"/);
    expect(p).toMatch(/"retry_after_seconds": 12/);
    // Drift sentinel — the body has no `bucket` field (it is a header).
    // The previous doc wrongly listed "bucket" in the JSON body; MUST NOT
    // come back. The header is documented in prose instead.
    expect(p).not.toMatch(/"bucket": "global"/);
    expect(p).toMatch(/x-ratelimit-bucket/);
  });

  it('CRITICAL Retry-After + exponential-backoff-capped-10s framing pinned. S36 2026-07-07 (fable-truth-audit): all three SDKs cap retry backoff (incl. the honoured Retry-After hint) at 10 seconds — TS maxDelayMs: 10_000 (sdk-typescript/src/retry.ts), Python max_delay_ms 10_000 (retry.py), Go MaxDelay 10s (retry.go); the old 30s claim matched no SDK.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `Retry-After` HTTP header carries the same value as\s*\n?`retry_after_seconds`\. SDK clients honour it automatically with\s*\n?exponential backoff capped at 10s/,
    );
    expect(p).not.toMatch(/capped at 30s/);
  });

  it('CRITICAL Source-of-truth pointers pinned — routes/account-rate-limits.ts + TIER_RATE_LIMIT_DEFAULTS + rate-limit-overrides-repo + admin-rate-limit-overrides route. Drift would lose canonical impl pointers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Routes: `apps\/server\/src\/routes\/account-rate-limits\.ts`\./);
    expect(p).toMatch(
      /Schema:\s*\n?`packages\/api-types\/src\/common\.ts:TIER_RATE_LIMIT_DEFAULTS`\./,
    );
    expect(p).toMatch(/Override repo: `apps\/server\/src\/db\/rate-limit-overrides-repo\.ts`\./);
    expect(p).toMatch(/Admin route: `apps\/server\/src\/routes\/admin-rate-limit-overrides\.ts`\./);
  });

  it('CRITICAL broad-read floor pinned. Account limits and staff override metadata cannot be read by zero-scope, write-only, or resource-granular keys.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Requires the broad `read` scope; `account_owner` also satisfies the\s*\n?gate\. Resource-granular, write-only, and zero-scope keys cannot inspect\s*\n?account-wide limits or staff-applied override metadata\./,
    );
    expect(p).not.toMatch(/no specific API-key scope/);
  });

  it('CRITICAL GET /v1/account/rate-limits canonical endpoint pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/account\/rate-limits`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-api-account-rate-limits-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
