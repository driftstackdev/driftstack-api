// W517.B — drift guard for apps/marketing-site/src/pages/docs/concurrency.astro.
// V-702 concurrency + backpressure docs. Drift here either changes a
// per-tier cap (would create marketing↔TIER_CONCURRENT_SESSION_LIMITS
// divergence) or breaks the backoff-on-type-URI canonical pattern.
//
//   • V-702 doc-comment framing.
//   • TIER_CONCURRENT_SESSION_LIMITS 8-tier cap table: trial_pack 1 +
//     solo_manual 1 + team_manual 3 + agency_manual 8 + api_starter 2 +
//     api_builder 8 + api_scale 24 + enterprise 32 (contract-raisable).
//   • "Concurrent session" = status ≠ destroyed && ≠ errored.
//   • V-352 30-minute idle-cleanup sweep.
//   • 429 concurrency-limit problem-type with current_sessions + limit
//     extension + Retry-After as hint not contract.
//   • Canonical client backoff loop: dispatch on type URI, exponential
//     with 60s cap, 5-attempt max.
//   • Pooling pattern: keep pool size below cap (e.g. 18 of 20).
//   • Separate-systems framing: rate-limits-page is distinct from this.
//   • GET /v1/account/me concurrent_session_active +
//     concurrent_session_cap fields.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/concurrency.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W517.B apps/marketing-site/src/pages/docs/concurrency.astro content parity', () => {
  const body = read(LIB);

  it("V-702 framing pinned: 'concurrency + backpressure developer docs.' — pinned so the V-702 anchor survives. The V-702 anchor lives in the page-header doc-comment (internal-facing), which is the only place internal V-anchors are allowed.", () => {
    expect(body).toMatch(/\/\/ V-702 — concurrency \+ backpressure developer docs\./);
  });

  it('TIER_CONCURRENT_SESSION_LIMITS 8-tier table pinned: trial_pack 1 (single-session evaluation) + solo_manual 1 (manual operator) + team_manual 3 (shared across team) + agency_manual 8 (shared across agency) + api_starter 2 + api_builder 8 + api_scale 24 + enterprise 32 (contract path can raise further) — pinned so the 8-tier-cap stays consistent with TIER_CONCURRENT_SESSION_LIMITS in @driftstack/api-types (drift to a different cap would create marketing↔server divergence)', () => {
    expect(body).toMatch(
      /Caps below match <code>TIER_CONCURRENT_SESSION_LIMITS<\/code> in\s*\n?\s*<code>@driftstack\/api-types<\/code>; the server reads from the\s*\n?\s*same constant\./,
    );
    expect(body).toMatch(
      /<tr><td><code>free<\/code><\/td><td>1<\/td><td>Perpetual free evaluation tier \(1 session, 20-min cap\)\.<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><code>solo_manual<\/code><\/td><td>1<\/td><td>Manual operator workflow\.<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><code>team_manual<\/code><\/td><td>3<\/td><td>Shared across the team\.<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><code>agency_manual<\/code><\/td><td>8<\/td><td>Shared across the agency\.<\/td><\/tr>/,
    );
    expect(body).toMatch(/<tr><td><code>api_starter<\/code><\/td><td>2<\/td><td><\/td><\/tr>/);
    expect(body).toMatch(/<tr><td><code>api_builder<\/code><\/td><td>8<\/td><td><\/td><\/tr>/);
    expect(body).toMatch(/<tr><td><code>api_scale<\/code><\/td><td>24<\/td><td><\/td><\/tr>/);
    expect(body).toMatch(
      /<tr><td><code>enterprise<\/code><\/td><td>32<\/td><td>Contract path can raise this further\.<\/td><\/tr>/,
    );
  });

  it("'Concurrent session' definition + 30-min idle-cleanup framing pinned: 'a session that has not yet been destroyed (status ≠ destroyed & ≠ errored). Cleanup is your responsibility — leaked sessions count against the cap until the 30-minute idle-cleanup sweep runs.' — pinned so the 'destroyed XOR errored' terminal-state definition + 30-min idle-cleanup commitment + cleanup-is-your-responsibility framing survives. The previous skip pinned inline `V-352 30-minute` with the V-anchor that was removed from the customer-facing copy as a UX cleanup (internal V-anchors should not bleed into marketing pages); the framing itself survives without it.", () => {
    expect(body).toMatch(
      /"Concurrent session" = a session that has not yet been\s*\n?\s*destroyed \(status &ne; <code>destroyed<\/code> &amp; &ne;\s*\n?\s*<code>errored<\/code>\)\. Cleanup is your responsibility — leaked\s*\n?\s*sessions count against the cap until the 30-minute\s*\n?\s*idle-cleanup sweep runs\./,
    );
    // Internal V-anchor must NOT bleed into customer-facing copy.
    expect(body).not.toMatch(/V-352 30-minute/);
  });

  it("429 concurrency-limit problem-type framing pinned: 'When a POST /v1/sessions would push you past the cap' + sample 429 with type 'https://errors.driftstack.dev/concurrency-limit' + title 'Concurrent session limit reached' + status 429 + detail with '24 active sessions; tier permits 24' + current_sessions + limit extension fields + 'The Retry-After header is a hint, not a contract — it's the time we estimate it'd take for one of your current sessions to naturally complete (based on your average session duration). Don't sleep blindly past it; respond when one of your own sessions finishes.' — pinned so the canonical problem-type URI + title + detail + 2-extension-fields (current_sessions/limit) + Retry-After-as-hint commitment survives", () => {
    expect(body).toMatch(/HTTP\/1\.1 429 Too Many Requests/);
    expect(body).toMatch(/Retry-After: 15/);
    expect(body).toMatch(/"type": "https:\/\/errors\.driftstack\.dev\/concurrency-limit"/);
    expect(body).toMatch(/"title": "Concurrent session limit reached"/);
    expect(body).toMatch(/"status": 429/);
    expect(body).toMatch(/"detail": "Account already has 24 active sessions; tier permits 24\."/);
    expect(body).toMatch(/"current_sessions": 24/);
    expect(body).toMatch(/"limit": 24/);
    expect(body).toMatch(
      /The <code>Retry-After<\/code> header is a hint, not a contract —\s*\n?\s*it's the time we estimate it'd take for one of your current\s*\n?\s*sessions to naturally complete \(based on your average session\s*\n?\s*duration\)\. Don't sleep blindly past it; respond when one of\s*\n?\s*your own sessions finishes\./,
    );
  });

  it("Canonical client backoff-loop framing pinned: createSessionWithBackoff TS snippet + 'Switch on the RFC 7807 type URI — clients should dispatch on the stable problem-type, not on title or detail strings' + maxAttempts 5 + delay 1_000 initial + exponential * 2 + 60_000 cap + 'Don't pre-emptively rate-limit yourself client-side. The server's cap is the truth — back off only when it tells you to.' — pinned so the 5-attempt + 1s-initial + 60s-cap + exponential-doubling + don't-pre-emptively-rate-limit-yourself commitments survive", () => {
    expect(body).toMatch(/async function createSessionWithBackoff\(client, opts\) \{/);
    expect(body).toMatch(/const maxAttempts = 5;/);
    expect(body).toMatch(/let delay = 1_000;/);
    expect(body).toMatch(
      /if \(err\.type !== 'https:\/\/errors\.driftstack\.dev\/concurrency-limit'\) throw err;/,
    );
    expect(body).toMatch(
      /const retryAfter = \(err\.retryAfterSeconds \?\? delay \/ 1000\) \* 1000;/,
    );
    expect(body).toMatch(/delay = Math\.min\(delay \* 2, 60_000\);\s+\/\/ exponential cap at 60s/);
    expect(body).toMatch(
      /Don't pre-emptively rate-limit yourself client-side\. The\s*\n?\s*server's cap is the truth — back off only when it tells you to\./,
    );
  });

  it("2-pattern pooling-vs-ephemeral framing pinned: Ephemeral (default — create / work / destroy, bounded by session-create-latency ~500ms) + Pooled (keep N alive, round-robin, manage health + respect cap) + 'For pooling: don't oversubscribe. If your tier caps at 20, run a pool of 18 — leaves headroom for ad-hoc creates that shouldn't have to evict pooled sessions.' — pinned so the 2-pattern + ~500ms-create-latency + 18-of-20-pool-sample commitment survives", () => {
    expect(body).toMatch(
      /<strong>Ephemeral \(default\):<\/strong> create a session,\s*\n?\s*do the work, destroy\. Simple, no leak risk\. Throughput is\s*\n?\s*bounded by session-create latency \(~500ms\)\./,
    );
    expect(body).toMatch(
      /<strong>Pooled:<\/strong> keep N sessions alive across\s*\n?\s*requests; round-robin work onto them\./,
    );
    expect(body).toMatch(
      /For pooling: don't oversubscribe\. If your tier caps at 20,\s*\n?\s*run a pool of 18 — leaves headroom for ad-hoc creates that\s*\n?\s*shouldn't have to evict pooled sessions\./,
    );
  });

  it("Rate-limits-vs-concurrency-limits separation framing pinned: 'These are separate systems' + Rate-limits (per-second tokens, request throughput, /docs/rate-limits cross-ref) + Concurrency-limits (active-session count) + 'Both surface as 429s but with different type URIs (.../rate-limited vs. .../concurrency-limit) so clients can dispatch on the stable problem-type.' — pinned so the 2-systems-separate + 2-distinct-type-URI dispatch-pattern survives (drift to merging into one system would invite client confusion on backoff)", () => {
    expect(body).toMatch(
      /<strong>Rate limits<\/strong> \(per-second tokens\) cap\s*\n?\s*<em>request throughput<\/em>\. See\s*\n?\s*<a href="\/docs\/rate-limits">\/docs\/rate-limits<\/a>\./,
    );
    expect(body).toMatch(
      /<strong>Concurrency limits<\/strong> \(this page\) cap\s*\n?\s*<em>active-session count<\/em>\. You can hit either one\s*\n?\s*independently\./,
    );
    expect(body).toMatch(
      /Both surface as 429s but with different\s*\n?\s*<code>type<\/code> URIs\s*\n?\s*\(<code>\.\.\.\/rate-limited<\/code> vs\.\s*\n?\s*<code>\.\.\.\/concurrency-limit<\/code>\) so clients can dispatch on\s*\n?\s*the stable problem-type\./,
    );
  });

  it("Raising-the-cap framing pinned: 'Upgrade to a higher tier via /pricing — the new cap applies immediately on tier change. For Enterprise overrides above the Enterprise default of 32, email sales@driftstack.dev; we can lift the cap without a tier change for short-term campaign bursts.' — pinned so the immediate-on-tier-change + sales@-channel-for-campaign-bursts + 32-Enterprise-default commitment survives", () => {
    expect(body).toMatch(
      /Upgrade to a higher tier via\s*\n?\s*<a href="\/pricing">\/pricing<\/a> — the new cap applies\s*\n?\s*immediately on tier change\. For Enterprise overrides above\s*\n?\s*the Enterprise default of 32, email\s*\n?\s*<a href="mailto:sales@driftstack\.dev">sales@driftstack\.dev<\/a>;\s*\n?\s*we can lift the cap without a tier change for short-term\s*\n?\s*campaign bursts\./,
    );
    // Anti-drift: the previous copy quoted a 500-default Enterprise cap.
    // The Enterprise default is 32 (matches TIER_CONCURRENT_SESSION_LIMITS);
    // ban the old 500 framing so it cannot creep back.
    expect(body).not.toMatch(/the default 500/);
  });

  it("Observability framing pinned: 'Track your own concurrency from the dashboard or via GET /v1/account/me (the response includes concurrent_session_active alongside concurrent_session_cap).' + audit-log session.created + session.destroyed entries cross-link + /docs/audit-log — pinned so the 2-account-me-field (concurrent_session_active + concurrent_session_cap) + 2-audit-log-events (session.created + session.destroyed) + /docs/audit-log cross-ref survives", () => {
    expect(body).toMatch(
      /Track your own concurrency from the dashboard or via\s*\n?\s*<code>GET \/v1\/account\/me<\/code> \(the response includes\s*\n?\s*<code>concurrent_session_active<\/code> alongside\s*\n?\s*<code>concurrent_session_cap<\/code>\)/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/audit-log">audit log<\/a> carries\s*\n?\s*<code>session\.created<\/code> \+ <code>session\.destroyed<\/code>\s*\n?\s*entries — diff them for an open-session timeseries\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
