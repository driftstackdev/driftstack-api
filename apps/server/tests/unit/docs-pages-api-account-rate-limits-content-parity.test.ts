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
      /For the broader explanation of how rate limits work \+ the per-tier\s*\n?defaults table, see \[\/reference\/rate-limits\]\(\/reference\/rate-limits\)\./,
    );
  });

  it("CRITICAL 3 bucket-key framing pinned — global (every /v1/*) + sessions:create (POST /v1/sessions only — lower cap) + agent_sessions:message (POST /v1/agent-sessions/:id/messages — isolated cap so LLM loops can't drain global). Matches W786 reference/rate-limits 3-bucket model.", () => {
    const p = read(PAGE);

    // v2-#8 sub-slice 8.20 added agent_sessions:message as the 3rd
    // bucket. The doc now says "Three bucket keys exist" with the
    // third bucket isolated from global so an LLM-driven message
    // loop can't drain the global cap.
    expect(p).toMatch(
      /Three bucket keys exist: `global` \(every\s*\n?authenticated `\/v1\/\*` call\), `sessions:create`\s*\n?\(`POST \/v1\/sessions` only — lower cap because session creation is\s*\n?expensive\), and `agent_sessions:message`\s*\n?\(`POST \/v1\/agent-sessions\/:id\/messages` — separate cap so an\s*\n?LLM-driven message loop can't drain the global bucket\)\./,
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

  it("CRITICAL bucket-reference 2-row table + 'BOTH buckets' framing pinned. The 'A POST /v1/sessions consumes from BOTH buckets — hitting either cap returns 429' wording matches W786 reference/rate-limits dual-bucket model.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\| `global`\s+\| Every authenticated `\/v1\/\*`\s+\| Coarse anti-abuse cap/);
    expect(p).toMatch(
      /\| `sessions:create`\s+\| `POST \/v1\/sessions` only\s+\| Lower cap because session creation is the most expensive op/,
    );
    expect(p).toMatch(
      /A `POST \/v1\/sessions` consumes from BOTH buckets — hitting either\s*\n?cap returns 429\./,
    );
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

  it("CRITICAL Customer-dashboard-surface framing pinned — TRUTHFUL version. The previous pin asserted '/usage renders the same data visually' which was source-of-truth-divergent (no such section exists in apps/customer-dashboard/src/pages/usage.astro). Now pins the honest 'read via SDK/curl; /usage shows time-series usage counts only; dedicated surface queued' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Read this endpoint directly via the SDK or `curl` — the customer\s*\n?dashboard does not yet render the rate-limit bucket config\s*\n?visually\./,
    );
    expect(p).toMatch(
      /The `\/usage` page on the dashboard shows time-series\s*\n?usage counts \(session minutes, navigates, captures, etc\.\) but not\s*\n?the per-bucket capacity \/ refill \/ source rows from this endpoint\./,
    );
    expect(p).toMatch(
      /A dedicated rate-limits surface is queued for a future dashboard\s*\n?slice\./,
    );
  });

  it('CRITICAL x-ratelimit-* response headers documented. Drift would orphan SDK consumers from the per-response capacity/remaining/reset surface emitted by middleware/rate-limit.ts. Pins all 4 headers + the emitted-on-every-status invariant.', () => {
    const p = read(PAGE);

    // Header names matching middleware/rate-limit.ts lines 62-65.
    expect(p).toMatch(/`x-ratelimit-bucket`/);
    expect(p).toMatch(/`x-ratelimit-limit`/);
    expect(p).toMatch(/`x-ratelimit-remaining`/);
    expect(p).toMatch(/`x-ratelimit-reset`/);
    // Invariant: headers are emitted regardless of status code so
    // retry logic can read them after a 4xx/429.
    expect(p).toMatch(/headers\s*\n?are emitted regardless of HTTP status/);
    // The combine-with-Retry-After-on-429 pattern.
    expect(p).toMatch(
      /combine\s*\n?`x-ratelimit-remaining=0` \+ `Retry-After` to drive a back-off/,
    );
  });

  it('CRITICAL 429 response shape pinned with bucket-field. The \'"bucket": "global"\' field on the response body is what tells SDK consumers WHICH cap was hit. Matches W776 + W786 reference/errors rate-limited contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/rate-limited"/);
    expect(p).toMatch(/"bucket": "global"/);
    expect(p).toMatch(/"retry_after_seconds": 12/);
  });

  it('CRITICAL Retry-After + exponential-backoff-capped-30s framing pinned. Matches W786 reference/rate-limits + W776 SDK default retry policy.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `Retry-After` HTTP header carries the same value as\s*\n?`retry_after_seconds`\. SDK clients honour it automatically with\s*\n?exponential backoff capped at 30s/,
    );
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

  it('CRITICAL read|account_owner scope required pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Required scope: `read` or `account_owner`\./);
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
