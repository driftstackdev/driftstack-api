// W517.A — drift guard for apps/marketing-site/src/pages/docs/rate-limits.astro.
// V-685 rate-limits + W198 TIER_RATE_LIMIT_DEFAULTS accuracy. Drift here
// either changes a bucket name (would create marketing↔server-bucket-
// enforcement divergence) or shifts the 429 RFC 7807 problem-type URI
// (would mislead clients on dispatch).
//
//   • V-685 doc-comment framing.
//   • W198 BUCKETS values mirror TIER_RATE_LIMIT_DEFAULTS in
//     packages/api-types/src/common.ts.
//
// V-813 — this header used to name the enforced set, and named it short:
// it listed the two buckets that existed when it was written, while the
// server was gating four. The count does not belong in prose on either
// side. `rate-limits-doc-bucket-parity.test.ts` now derives the set from
// TIER_RATE_LIMIT_DEFAULTS in BOTH directions; this file pins wording
// only, and deliberately asserts nothing about how many rows there are.
//   • Per-account (not per-key) bucket scope.
//   • 4-rate-limit-header surface: Limit / Remaining / Reset / Bucket.
//   • 429 RFC 7807 problem+json with 'rate-limited' type URI +
//     retry_after_seconds extension.
//   • 3-step recovery: stop bucket → wait Retry-After → ramp-back-up
//     with reduced concurrency; sustained-429-treated-as-abuse.
//   • 2-problem-type URI dispatch: rate-limited vs concurrency-limit
//     (both 429, distinguished by type URI).
//   • 5× / 48h override request to support@driftstack.dev.
//   • Self-hosted dev stack runbook cross-reference.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/rate-limits.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W517.A apps/marketing-site/src/pages/docs/rate-limits.astro content parity', () => {
  const body = read(LIB);

  it("V-685 + W198 source-of-truth framing pinned: the doc-comment anchor and the statement that the rendered values mirror the live TIER_RATE_LIMIT_DEFAULTS table. V-813 REMOVED this case's third clause, which quoted a sentence claiming the enforced set was smaller than it was — that clause was pinned prose asserting a count, and the sentinel below forbids either stale phrasing returning.", () => {
    expect(body).toMatch(
      /\/\/ V-685 — rate-limits developer docs\. Companion to \/docs\/webhooks \+\s*\/\/ https:\/\/docs\.driftstack\.io\/quickstart-curl\/; describes the bucket model, the headers\s*\/\/ returned on every response, what to do when 429ed, and how to\s*\/\/ request an override\./,
    );
    expect(body).toMatch(
      /\/\/ W198 — values mirror the live `TIER_RATE_LIMIT_DEFAULTS` table in\s*\/\/ `packages\/api-types\/src\/common\.ts`\./,
    );
    // The rationale for each isolated bucket, which is worth pinning —
    // unlike the count, which is not.
    expect(body).toMatch(/LLM-driven message loops can't drain global/);
    expect(body).toMatch(/keystroke\/pointer stream of a live takeover/);

    // V-813 SENTINEL. Both spellings of the stale count are banned. The
    // first froze a set of three while the server gated four; the second
    // is the older two-bucket phrasing this file's header used to carry.
    // A count in prose is wrong on the next addition and, pinned, it
    // stops the page being corrected at all — which is exactly what
    // happened here for the whole life of the input_event bucket.
    expect(body, 'the bucket count must not be restated in prose').not.toMatch(/Three buckets/);
    expect(body, 'the bucket count must not be restated in prose').not.toMatch(
      /only `?global`? (?:\+|and) `?sessions:create`? are enforced/,
    );
  });

  it("BUCKETS row wording pinned: 'global' (every authenticated request, default catch-all) Solo 120/120 + API Builder 1,800/1,800 + 'sessions:create' (POST /v1/sessions, burst-sensitive, throttled-tighter-than-global) Solo 10/2 + API Builder 60/60 — pinned so the Solo/Builder rate-pair sample stays consistent with TIER_RATE_LIMIT_DEFAULTS (drift to a different rate-pair would create marketing↔common.ts divergence). V-813 retitled this case: it used to name a row count, and the numbers are what matter here.", () => {
    expect(body).toMatch(/name: 'global'/);
    expect(body).toMatch(
      /Every authenticated request increments this bucket\. The default rate-limit catch-all\./,
    );
    expect(body).toMatch(/soloBurst: '120 burst'/);
    expect(body).toMatch(/soloSustained: '120 req\/min'/);
    expect(body).toMatch(/apiBuilderBurst: '1,800 burst'/);
    expect(body).toMatch(/apiBuilderSustained: '1,800 req\/min'/);
    expect(body).toMatch(/name: 'sessions:create'/);
    expect(body).toMatch(
      /POST \/v1\/sessions — burst-sensitive; throttled tighter than `global` to keep one customer from saturating the fleet\./,
    );
    expect(body).toMatch(/soloBurst: '10 burst'/);
    expect(body).toMatch(/soloSustained: '2 req\/min'/);
    expect(body).toMatch(/apiBuilderBurst: '60 burst'/);
    expect(body).toMatch(/apiBuilderSustained: '60 req\/min'/);

    // V-813 — the row that was missing. Its absence is why a customer
    // sizing a takeover client against this table had no figure to size
    // against, one paragraph below prose telling them there were four
    // buckets and to validate the header against four values.
    expect(body).toMatch(/name: 'agent_sessions:input_event'/);
    expect(body).toMatch(/soloBurst: '360 burst'/);
    expect(body).toMatch(/soloSustained: '5,400 req\/min'/);
    expect(body).toMatch(/apiBuilderBurst: '600 burst'/);
    expect(body).toMatch(/apiBuilderSustained: '9,000 req\/min'/);
  });

  it("Per-account-not-per-key + tier-comparison cross-link pinned. V-753 REPLACED the Free-equals-Solo-Manual clause: EVERY one of free's buckets is SMALLER (V-813 dropped the numeral — 'every' is the stronger claim and does not need updating when a bucket is added), so the page now states free's own numbers and this pin forbids the old claim returning (a second pin in marketing-site/tests carries the cross-source check against TIER_RATE_LIMIT_DEFAULTS.free)", () => {
    expect(body).toMatch(
      /Buckets are <strong>per account<\/strong>, not per API key\. If\s*you mint 10 keys to spread your load, you're still hitting\s*the same buckets — the limit is on the account\./,
    );
    expect(body).toMatch(
      /Higher tiers \(API Scale, Enterprise\) get larger buckets — see\s*the <a href="\/pricing\/comparison\/">tier comparison<\/a> for the\s*full matrix\./,
    );
    // V-753 — free is smaller on all four buckets; the old sentence sent free readers
    // to the Solo column and they were 429'd at half the documented global capacity.
    expect(body).toMatch(/Free has its own, smaller buckets on every\s*limit/);
    expect(body).not.toMatch(/Free uses the same bucket sizes as Solo/);
    expect(body).not.toContain('href="/pricing/comparison"');
    expect(body.replace('href="/pricing/comparison/"', 'href="/pricing/comparison"')).toContain(
      'href="/pricing/comparison"',
    );
  });

  it('4-rate-limit-header surface pinned: X-RateLimit-Limit (bucket capacity tokens) + X-RateLimit-Remaining (tokens left after this request) + X-RateLimit-Reset (Unix seconds when bucket full) + X-RateLimit-Bucket (bucket name) + 20%-low-water-mark proactive-slowdown guidance — pinned so the 4-header surface + 20%-low-water-mark client guidance survives', () => {
    expect(body).toMatch(
      /<td><code>X-RateLimit-Limit<\/code><\/td><td>The bucket capacity \(tokens\)\.<\/td>/,
    );
    expect(body).toMatch(
      /<td><code>X-RateLimit-Remaining<\/code><\/td><td>Tokens left after this request\.<\/td>/,
    );
    expect(body).toMatch(
      /<td><code>X-RateLimit-Reset<\/code><\/td><td>Unix seconds when the bucket will be full again\.<\/td>/,
    );
    expect(body).toMatch(
      /<td><code>X-RateLimit-Bucket<\/code><\/td><td>The bucket name \(e\.g\. <code>sessions:create<\/code>\)\.<\/td>/,
    );
    expect(body).toMatch(
      /Track <code>X-RateLimit-Remaining<\/code> against a low-water\s*mark in your client; if it drops below, say, 20% of the limit,\s*slow your request rate proactively rather than waiting for the\s*429\./,
    );
  });

  it("429 RFC 7807 + 'rate-limited' type URI + retry_after_seconds extension framing pinned: 'The body follows RFC 7807 (application/problem+json) — flat keys, no error envelope.' + sample 429 with type 'https://errors.driftstack.dev/rate-limited' + 4-header surface (Retry-After/Bucket/Limit/Remaining/Reset) + retry_after_seconds extension — pinned so the RFC-7807 + flat-no-envelope + canonical-type-URI + retry_after_seconds-extension survives (drift to wrapping in 'error' envelope would create marketing↔problem+json divergence)", () => {
    expect(body).toMatch(
      /The body follows RFC 7807 \(<code>application\/problem\+json<\/code>\) —\s*flat keys, no <code>error<\/code> envelope\./,
    );
    expect(body).toMatch(/HTTP\/1\.1 429 Too Many Requests/);
    expect(body).toMatch(/Retry-After: 12/);
    expect(body).toMatch(/X-RateLimit-Bucket: sessions:create/);
    expect(body).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/rate-limited"/);
    expect(body).toMatch(/"title": "Too Many Requests"/);
    expect(body).toMatch(/"status": 429/);
    expect(body).toMatch(/"retry_after_seconds": 12/);
  });

  it("3-step recovery framing pinned: stop-sending-requests-to-same-bucket + wait at-least-Retry-After-seconds + resume-with-reduced-concurrency-gradually-ramp-back-up + 'Do not retry-loop without backoff. We log sustained 429s as abuse and may rate-limit further or temporarily disable your key.' — pinned so the 3-step recovery + sustained-429-abuse-policy + key-disable threat survives", () => {
    expect(body).toMatch(/<li>Stop sending requests to the same bucket immediately\.<\/li>/);
    expect(body).toMatch(/<li>Wait at least <code>Retry-After<\/code> seconds\.<\/li>/);
    expect(body).toMatch(/<li>Resume with reduced concurrency; gradually ramp back up\.<\/li>/);
    expect(body).toMatch(
      /<strong>Do not<\/strong> retry-loop without backoff\. We log\s*sustained 429s as abuse and may rate-limit further or\s*temporarily disable your key\./,
    );
  });

  it("2-problem-type-URI dispatch framing pinned: 'concurrency-limit' problem-type for concurrency-cap-429 vs 'rate-limited' problem-type for bucket-429 + 'Dispatch on the type URI, not the status code.' + TIER_CONCURRENT_SESSION_LIMITS anchor + /docs/concurrency cross-ref — pinned so the 2-distinct-problem-type + dispatch-on-type-not-status + TIER_CONCURRENT_SESSION_LIMITS source-of-truth commitment survives", () => {
    expect(body).toMatch(
      /The caps\s*mirror <code>TIER_CONCURRENT_SESSION_LIMITS<\/code> exactly;\s*see <a href="https:\/\/docs\.driftstack\.io\/guides\/concurrency\/">\/docs\/concurrency<\/a> for the\s*authoritative table \+ backoff guidance\./,
    );
    expect(body).toMatch(
      /<code>https:\/\/errors\.driftstack\.dev\/concurrency-limit<\/code>\s*problem-type — distinct from rate-limit 429s, which use the\s*<code>https:\/\/errors\.driftstack\.dev\/rate-limited<\/code> type\.\s*Dispatch on the <code>type<\/code> URI, not the status code\./,
    );
  });

  it("5×/48h override + support@driftstack.dev + dashboard Settings → Rate limits framing pinned: 'For one-off events (load tests, customer-facing demos), email support@driftstack.dev describing the bucket(s) + multiplier + duration you need. We generally approve up to 5× for up to 48h on the spot for paid tiers.' + 'Overrides are visible in your dashboard under Settings → Rate limits. They expire automatically at the configured time.' — pinned so the 5×-48h-on-the-spot-paid-tiers commitment + Settings→Rate-limits-dashboard-surface survives", () => {
    expect(body).toMatch(
      /For one-off events \(load tests, customer-facing demos\), email\s*<a href="mailto:support@driftstack\.dev">support@driftstack\.dev<\/a>\s*describing the bucket\(s\) \+ multiplier \+ duration you need\. We\s*generally approve up to 5× for up to 48h on the spot for paid\s*tiers\./,
    );
    expect(body).toMatch(
      /Overrides are visible in your dashboard under\s*<strong>Settings → Rate limits<\/strong>\. They expire\s*automatically at the configured time\./,
    );
  });

  it("Self-hosted dev stack runbook cross-reference pinned: 'The self-hosted dev stack (see the self-hosted mac local runbook) runs the same rate-limit code path against a local Redis. Use it to exercise your 429 handling without consuming real production budget.' + GitHub URL to docs/runbooks/self-hosted-mac-local.md — pinned so the local-Redis + same-code-path + self-hosted-mac-local-runbook-anchor survives", () => {
    expect(body).toMatch(
      /<a href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/blob\/main\/docs\/runbooks\/self-hosted-mac-local\.md">self-hosted mac local<\/a>/,
    );
    expect(body).toMatch(
      /runbook\) runs the same rate-limit code path against a local\s*Redis\. Use it to exercise your 429 handling without consuming\s*real production budget\./,
    );
  });

  it("developers@driftstack.dev support framing pinned: 'Sustained 429s that you didn't expect, or a need to discuss a production-impacting limit: developers@driftstack.dev.' — pinned so the developer-channel routing for unexpected-429 + production-impacting-limit conversations survives", () => {
    expect(body).toMatch(
      /Sustained 429s that you didn't expect, or a need to discuss a\s*production-impacting limit:\s*<a href="mailto:developers@driftstack\.dev">developers@driftstack\.dev<\/a>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
