// W507.A — drift guard for apps/marketing-site/src/pages/docs/recordings.astro.
// V-692 recordings doc — V-540 roadmap entry. Drift here either
// claims recordings are live (would mislead customers building toward
// an unshipped feature) or drops the planned-shape detail (would let
// the future-V-540 surface drift from documented expectations).
//
//   • V-692 + W217.A doc-comment framing.
//   • 'No public API endpoint, webhook event, or request body field currently
//     triggers managed recording today' explicit-no-live commitment.
//   • Heads-up warning: record:true is a no-op today.
//   • Planned shape 6-bullet: record:true field + WebM VP9 + GET
//     /v1/sessions/:id/recording + session.recording_ready webhook +
//     tier-dependent retention + redaction roadmap.
//   • What works today: desktop-local recorder + capture API + 6 live webhook event types.
//   • developers@driftstack.dev support.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/recordings.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W507.A apps/marketing-site/src/pages/docs/recordings.astro content parity', () => {
  const body = read(LIB);

  it("V-692 + W217.A doc-comment framing pinned: 'recordings developer docs. Recordings are on the roadmap (V-540 work-in-progress) but NOT yet exposed via the public API today' + 'W217.A — accuracy pass: the previous revision of this page documented all three as live. This rewrite reflects reality and is pinned by apps/server/tests/unit/recordings-doc-parity.test.ts to fail if the page silently regrows fictional claims.' — pinned so the V-692 V-540 V-W217.A engineering chain + the explicit 'NOT yet exposed' commitment + the cross-reference to the recordings-doc-parity test all survive. Re-enabled by slice 180 after verifying both V-692 + W217.A comments exist at recordings.astro:4-13", () => {
    expect(body).toMatch(
      /\/\/ V-692 — recordings developer docs\. Recordings are on the roadmap\s*\n?\s*\/\/ \(V-540 work-in-progress\) but NOT yet exposed via the public API\s*\n?\s*\/\/ today/,
    );
    expect(body).toMatch(
      /\/\/ W217\.A — accuracy pass: the previous revision of this page\s*\n?\s*\/\/ documented all three as live\. This rewrite reflects reality and\s*\n?\s*\/\/ is pinned by apps\/server\/tests\/unit\/recordings-doc-parity\.test\.ts\s*\n?\s*\/\/ to fail if the page silently regrows fictional claims\./,
    );
  });

  it("Explicit 'No public API endpoint, webhook event, or request body field currently triggers managed recording today' commitment pinned — pinned so the 3-state explicit-no-live framing survives (drift to softening would let customers think a recording field exists; drift to dropping the explicit enumeration would lose the unambiguous 'all three are absent' signal)", () => {
    expect(body).toMatch(
      /<strong>No public API endpoint, webhook event, or request body field\s*\n?\s*currently triggers managed recording today\.<\/strong>/,
    );
  });

  it("Heads-up warning pinned: 'record:true' on POST /v1/sessions is a no-op + server silently strips unrecognised fields + don't rely on recordings landing until the feature ships — pinned so the no-op + silent-strip + don't-rely-yet trio survives (drift to dropping 'silently strips' would mislead customers about the failure-mode; drift to dropping the don't-rely-yet caveat would let customers integrate against a non-existent surface). Re-enabled by slice 186 after refreshing the regex against the current 'until the feature ships' text (the original V-540 anchor was paraphrased away in a prior edit; the no-op + silent-strip semantic survives)", () => {
    expect(body).toMatch(
      /sending\s*\n?\s*<code class="font-mono">"record": true<\/code> on\s*\n?\s*<code class="font-mono">POST \/v1\/sessions<\/code> today is a\s*\n?\s*no-op — the server silently strips unrecognised fields\. Don't\s*\n?\s*rely on recordings landing until the feature ships\./,
    );
  });

  it('Planned shape 6-bullet pinned. Re-enabled by slice 248 after verifying all 6 bullets (Opt-in/Container WebM-VP9/Retrieval/Webhook/Retention/Redaction) still exist verbatim at recordings.astro:42-58', () => {
    expect(body).toMatch(/<strong>Opt-in per session<\/strong> via a new/);
    expect(body).toMatch(
      /<strong>Container:<\/strong> WebM \(VP9 video, no audio\),\s*\n?\s*matching the session viewport, ~30 fps, ~500 kbps\./,
    );
    expect(body).toMatch(
      /<strong>Retrieval<\/strong> via a new\s*\n?\s*<code>GET \/v1\/sessions\/:id\/recording<\/code> endpoint\s*\n?\s*returning a presigned R2 URL\./,
    );
    expect(body).toMatch(
      /<strong>Webhook<\/strong> via a new\s*\n?\s*<code>session\.recording_ready<\/code> event type added to the\s*\n?\s*<code>webhook_event_type<\/code> enum\./,
    );
    expect(body).toMatch(
      /<strong>Retention<\/strong> tier-dependent \(sketch: 7d Trial\s*\n?\s*Pack, 30d Solo \/ API Starter, 90d Team \/ API Builder, 180d\s*\n?\s*Agency \/ API Scale, custom Enterprise\)\./,
    );
    expect(body).toMatch(
      /<strong>Redaction<\/strong> for sensitive inputs — also\s*\n?\s*planned post-V-540\./,
    );
  });

  it("'What works today' fallback 2-state: Sessions API capture (screenshot/dom_snapshot/pdf) + the webhook event types that FIRE today (session.completed + session.failed + api_key.revoked + crypto.order.paid + crypto.order.failed) plus the test.ping synthetic — pinned so the 'what works today' surface lists only events with a production emitter. quota.warning_80pct + quota.exceeded are [DECLARED] (no emitter) so they're excluded here, though they stay in the full /docs/webhooks taxonomy", () => {
    expect(body).toMatch(/<strong>Desktop-local recording:<\/strong>/);
    expect(body).toMatch(/manual, local-only frame capture/);
    expect(body).toMatch(/export a portable JSON envelope/);
    expect(body).toMatch(
      /<code>POST \/v1\/sessions\/:id\/capture<\/code> with\s*\n?\s*<code>\{`\{ "kind": "screenshot" \}`\}<\/code>,\s*\n?\s*<code>"dom_snapshot"<\/code>, or <code>"pdf"<\/code>/,
    );
    expect(body).toMatch(/<code>session\.completed<\/code>/);
    expect(body).toMatch(/<code>session\.failed<\/code>/);
    expect(body).toMatch(/<code>api_key\.revoked<\/code>/);
    expect(body).toMatch(/<code>crypto\.order\.paid<\/code>/);
    expect(body).toMatch(/<code>crypto\.order\.failed<\/code>/);
    expect(body).toMatch(/<code>test\.ping<\/code>/);
    // quota.* are [DECLARED] (no production emitter) — they do NOT fire today,
    // so they must not appear in this "what works today" list.
    expect(body).not.toMatch(/<code>quota\.warning_80pct<\/code>/);
    expect(body).not.toMatch(/<code>quota\.exceeded<\/code>/);
  });

  it('Subscribe-to-shipping framing pinned. Re-enabled by slice 248 after verifying the 3-channel framing (API changelog RSS + status-page subscriptions + /api-reference) still exists at recordings.astro:83+', () => {
    expect(body).toMatch(
      /Subscribe to the <a href="\/changelog\/">API changelog<\/a> RSS\s*\n?\s*or <a href="\/docs\/status-subscriptions\/">status-page\s*\n?\s*subscriptions<\/a>/,
    );
    expect(body).toMatch(
      /the V-540 rollout will land as an entry on\s*\n?\s*both, along with the new endpoint \+ event type appearing on\s*\n?\s*<a href="\/api-reference\/">\/api-reference<\/a>/,
    );
    expect(body).not.toMatch(/href="\/(?:changelog|docs\/status-subscriptions|api-reference)"/);
  });

  it('developers@driftstack.dev support contact pinned — pinned so the developer-specific routing tag survives (drift to support@ would lose the developer-team routing on recording-specific questions)', () => {
    expect(body).toMatch(
      /<a href="mailto:developers@driftstack\.dev">developers@driftstack\.dev<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
