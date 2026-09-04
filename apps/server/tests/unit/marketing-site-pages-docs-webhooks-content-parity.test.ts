// W515.B — drift guard for apps/marketing-site/src/pages/docs/webhooks.astro.
// V-684 webhooks developer docs. Drift here either changes the signature
// format (would create marketing↔webhook-signing.ts divergence), breaks
// the retry schedule (would create marketing↔durable-webhook-delivery.ts
// divergence), or shifts the auto-disable threshold (would create
// marketing↔webhook-worker.ts divergence).
//
//   • V-684 doc-comment framing + W213.A 5-source-file accuracy pass.
//   • EVENT_TYPES array: 8 customer-subscribable types + test.ping
//     bypass-event.
//   • Endpoint cap: 10 active per account + narrow-purpose-over-mega.
//   • POST /v1/webhooks 201 with secret-shown-ONCE + secret_prefix
//     + delivery_counts (pending/delivered/failed/dlq).
//   • HTTPS-only enforcement at registration.
//   • 4-header delivery: X-Driftstack-Event-Id / -Event-Type /
//     -Emitted-At / -Signature.
//   • HMAC-SHA256(secret, ts + "." + raw body) + ts inside header.
//   • 6-attempt retry: 1m + 5m + 15m + 30m + 60m + DLQ.
//   • 50-consecutive-failures auto-disable + 10s timeout.
//   • 24h secret-rotation grace window + dual-header (-Signature + -Signature-Prev).
//   • test.ping bypass via POST /v1/webhooks/<id>/test.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/webhooks.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W515.B apps/marketing-site/src/pages/docs/webhooks.astro content parity', () => {
  const body = read(LIB);

  it('V-684 + W213.A 5-source-file accuracy-pass framing pinned: companion to /docs/api-quickstart + /docs/oauth-apps + 5-source-of-truth (webhook-signing.ts / durable-webhook-delivery.ts / webhook-worker.ts / webhooks.ts route / db/schema.ts) — pinned so the V-684 anchor + 5-source-file accuracy-pass commitment survives (drift to dropping the source-file list would let the doc drift away from server reality)', () => {
    expect(body).toMatch(
      /\/\/ V-684 — webhooks developer docs\. Companion to https:\/\/docs\.driftstack\.io\/quickstart-curl\/\s*\/\/ \+ \/docs\/oauth-apps; covers the subscribe→deliver→verify→retry\s*\/\/ loop developers integrate against\./,
    );
    expect(body).toMatch(
      /\/\/ W213\.A — full accuracy pass against the source of truth:\s*\/\/\s+- apps\/server\/src\/lib\/webhook-signing\.ts \(signature format\)\s*\/\/\s+- apps\/server\/src\/services\/durable-webhook-delivery\.ts \(retry\s*\/\/\s+schedule \+ max attempts\)\s*\/\/\s+- apps\/server\/src\/services\/webhook-worker\.ts \(auto-disable\s*\/\/\s+threshold\)/,
    );
  });

  it('pins the current 8 customer-subscribable event types and excludes retired quota declarations', () => {
    expect(body).toMatch(/name: 'session\.completed'/);
    expect(body).toMatch(/name: 'session\.failed'/);
    expect(body).toMatch(/name: 'api_key\.revoked'/);
    expect(body).toMatch(/name: 'session\.egress_capability_changed'/);
    expect(body).toMatch(/name: 'crypto\.order\.paid'/);
    expect(body).toMatch(/name: 'crypto\.order\.failed'/);
    expect(body).toMatch(/name: 'session\.challenge_detected'/);
    expect(body).toMatch(/name: 'session\.profile_save_failed'/);
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  it("test.ping bypass-only framing pinned: 'test.ping is an additional event type that exists only for the POST /v1/webhooks/<id>/test endpoint; it bypasses subscriptions, so you don't list it under events when creating an endpoint.' — pinned so the test.ping-bypass + don't-list-on-create commitment survives (drift to claiming test.ping is subscribable would create marketing↔schema divergence)", () => {
    expect(body).toMatch(
      /<code>test\.ping<\/code> is an additional event type that exists\s*only for the <code>POST \/v1\/webhooks\/&lt;id&gt;\/test<\/code> endpoint;\s*it bypasses subscriptions, so you don't list it under\s*<code>events<\/code> when creating an endpoint\./,
    );
  });

  it("10-endpoint cap + narrow-purpose-over-mega framing pinned: 'Each account can have up to 10 active endpoints. Mint as many narrow-purpose endpoints as you need rather than one mega-endpoint that fans out — easier to retire individual integrations later.' — pinned so the 10-cap + narrow-over-mega commitment survives (drift to a different cap would create marketing↔server-limit divergence)", () => {
    expect(body).toMatch(
      /Each account can have up to 10 active endpoints\. Mint as many\s*narrow-purpose endpoints as you need rather than one mega-endpoint\s*that fans out — easier to retire individual integrations later\./,
    );
  });

  it("POST /v1/webhooks create response framing pinned: 201 Created + 'secret': 'whsec_…' shown ONCE + 'secret_prefix': 'whsec_xxxx' + active true + consecutive_failures 0 + delivery_counts {pending,delivered,failed,dlq} all 0 — pinned so the canonical create-response shape + secret-once + 4-counter delivery_counts + active+consecutive_failures+created_at fields survives", () => {
    expect(body).toMatch(/→ 201 Created/);
    expect(body).toMatch(/"secret": "whsec_…",\s*← shown ONCE; copy it now/);
    expect(body).toMatch(/"secret_prefix": "whsec_xxxx"/);
    expect(body).toMatch(/"active": true/);
    expect(body).toMatch(/"consecutive_failures": 0/);
    expect(body).toMatch(
      /"delivery_counts": \{ "pending": 0, "delivered": 0, "failed": 0, "dlq": 0 \}/,
    );
  });

  it('Secret-shown-ONCE + rotate-secret + secret_prefix-12-plaintext-chars framing pinned + HTTPS-only enforcement at registration — pinned so the secret-once-immutable + rotate-secret endpoint + 12-plaintext-chars-non-sensitive + HTTPS-only-rejected commitments survive (drift to leaking the secret on GET would create marketing↔server divergence)', () => {
    expect(body).toMatch(
      /the <code>secret<\/code> is shown\s*once in the create response and never again/,
    );
    expect(body).toMatch(
      /rotate via\s*<code>POST \/v1\/webhooks\/&lt;id&gt;\/rotate-secret<\/code>\./,
    );
    expect(body).toMatch(
      /<code>secret_prefix<\/code> \(first 12 plaintext\s*chars, non-sensitive\) for display\./,
    );
    expect(body).toMatch(
      /Endpoint URLs MUST be HTTPS\. <code>http:\/\/<\/code> is rejected\s*at registration time\./,
    );
  });

  it('Delivery-header surface pinned: Event-Id + Event-Type + Signature (t=…,v1=…), and the headers the durable path DROPPED must not reappear in the samples. Secret rotation folds the prev HMAC into a second v1= inside the SAME single header. V-1486 — this arm named a header count and pinned an Emitted-At line the delivery has not sent since the durable cutover, so the count in its own title was part of the drift. The count is gone; the arm below derives the set from the delivery code.', () => {
    // V-1485 — this pin quoted `evt_…`, which the server has never minted:
    // both webhook mint sites use a bare `randomUUID()`. The customer docs
    // site had it right all along (`webhooks/events.md` documents
    // `X-Driftstack-Event-Id: <uuid>`), so this page contradicted the code
    // AND the other doc surface, with a passing pin holding it in place.
    expect(body).toMatch(/X-Driftstack-Event-Id: <uuid>/);
    expect(body).toMatch(/X-Driftstack-Event-Type: session\.completed/);
    // V-1486 — was `toMatch(/X-Driftstack-Emitted-At: 1747051200/)`, pinning a
    // header the durable dispatcher does not send. It was dropped alongside
    // `x-driftstack-signature-prev` when that path moved to the single
    // `t=…,v1=…` header the SDK verifier parses;
    // `durable-webhook-signature-sdk-verify` asserts both are undefined on the
    // emitted request. The page kept advertising one of them.
    expect(body).not.toContain('X-Driftstack-Emitted-At:');
    expect(body).not.toContain('X-Driftstack-Signature-Prev');
    expect(body).toMatch(/X-Driftstack-Signature: t=1747051200,v1=<hex hmac>/);
    expect(body).toMatch(
      /the single\s*<code>X-Driftstack-Signature<\/code> header carries both the new/,
    );
    expect(body).not.toMatch(/X-Driftstack-Signature-Prev/);
  });

  it('HMAC framing pinned: the algorithm, the timestamp living in the signature header rather than a separate one, and an explicit denial that an Emitted-At header exists. V-1486 replaced a warning not to USE that header with a statement that it is not sent — advising customers about the semantics of a header they will never receive is worse than silence.', () => {
    expect(body).toMatch(/hmac = HMAC-SHA256\(/);
    expect(body).toMatch(/<unix-seconds> \+ "\." \+ <raw request body>/);
    expect(body).toMatch(
      /The timestamp lives inside the header \(the <code>t=<\/code>\s*component\), not in a separate header\. There is no\s*<code>X-Driftstack-Emitted-At<\/code> header: the delivery path\s*sends exactly three <code>X-Driftstack-\*<\/code> headers —\s*Event-Id, Event-Type and Signature\./,
    );
  });

  it('Node.js verify-snippet 4-anchor framing pinned: raw req.rawBody (NOT parsed JSON) + 5-minute replay window (Math.abs(Date.now()/1000 - ts) > 300) + timingSafeEqual + 3-SDK helper surface (TS @driftstack/sdk verifyWebhookSignature, Python verify_webhook_signature, Go VerifyWebhookSignature) — pinned so the raw-body + 300s-replay-window + timingSafeEqual + 3-SDK-helper triplet survives (drift to widening the replay window would weaken replay-protection)', () => {
    expect(body).toMatch(/const body = req\.rawBody;\s+\/\/ RAW bytes — NOT parsed JSON/);
    expect(body).toMatch(/if \(Math\.abs\(Date\.now\(\) \/ 1000 - ts\) > 300\) return false;/);
    expect(body).toMatch(/timingSafeEqual\(a, b\)/);
    expect(body).toMatch(
      /<code>import \{'\{'\} verifyWebhookSignature \{'\}'\} from '@driftstack\/sdk'<\/code>/,
    );
    expect(body).toMatch(/<code>from driftstack import verify_webhook_signature<\/code>/);
    expect(body).toMatch(/<code>driftstack\.VerifyWebhookSignature\(\.\.\.\)<\/code>/);
  });

  it('6-attempt retry schedule pinned: 1 (initial, —) + 2 (1 min) + 3 (5 min) + 4 (15 min) + 5 (30 min) + 6 (60 min, final) + DLQ-after-6 + 50-consecutive-failures auto-disable + 10s timeout — pinned so the 6-attempt schedule + DLQ-trigger + 50-consec auto-disable + 10s-timeout commitment all survive (drift to a different schedule would create marketing↔durable-webhook-delivery.ts divergence)', () => {
    expect(body).toMatch(/<tr><td>1 \(initial\)<\/td><td>—<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>2<\/td><td>1 minute after attempt 1<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>3<\/td><td>5 minutes after attempt 2<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>4<\/td><td>15 minutes after attempt 3<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>5<\/td><td>30 minutes after attempt 4<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>6 \(final\)<\/td><td>60 minutes after attempt 5<\/td><\/tr>/);
    expect(body).toMatch(
      /After <strong>6 attempts<\/strong> \(the initial delivery plus\s*5 retries\), the delivery moves to a dead-letter queue \(DLQ\)/,
    );
    expect(body).toMatch(
      /After <strong>50 consecutive failures across all deliveries<\/strong>\s*for one endpoint, the endpoint is auto-disabled\./,
    );
    expect(body).toMatch(
      /Request timeout is <strong>10 seconds<\/strong> — slower than\s*that, we consider the delivery failed and back off\./,
    );
  });

  it('Endpoint requirements 3-rule framing pinned: 2xx-within-10s + idempotent-on-X-Driftstack-Event-Id (we may retry the same id if our delivery infra retried before getting your response) + ack-fast-process-async — pinned so the 3-rule receiver-contract survives', () => {
    expect(body).toMatch(/<li>Return 2xx within 10 seconds\.<\/li>/);
    expect(body).toMatch(
      /Be <strong>idempotent<\/strong> — we may retry the same\s*<code>X-Driftstack-Event-Id<\/code> if our delivery infra\s*retried before getting your response\./,
    );
    expect(body).toMatch(
      /Acknowledge fast \+ process asynchronously\. A 200 response\s*means "I have the payload"; process it on your side after\./,
    );
  });

  it("24h secret-rotation grace + grace_expires_at + compound dual-v1= framing pinned: POST /v1/webhooks/<id>/rotate-secret 200 OK + secret_prefix new + prev_secret_prefix + grace_expires_at + 'During the 24-hour grace window, Driftstack signs every outbound delivery with both secrets inside the single X-Driftstack-Signature header, as two v1= entries' — pinned so the 24h-grace + single-header-dual-v1= + prev-secret-prefix-on-response survives (no separate prev header)", () => {
    expect(body).toMatch(/POST \/v1\/webhooks\/<id>\/rotate-secret/);
    expect(body).toMatch(/"secret": "whsec_NEW…"/);
    expect(body).toMatch(/"prev_secret_prefix": "whsec_xxxx"/);
    expect(body).toMatch(/"grace_expires_at":/);
    expect(body).toMatch(
      /Driftstack signs every\s*outbound delivery with <strong>both secrets inside the single/,
    );
    expect(body).toMatch(/<code>v1=&lt;new&gt;<\/code> — signed with the new secret\./);
    expect(body).toMatch(/<code>v1=&lt;old&gt;<\/code> — signed with the old secret\./);
  });

  it("test.ping POST /v1/webhooks/<id>/test 202 framing pinned: 202 Accepted + a prefixed delivery id + an UNPREFIXED event id + event_type 'test.ping' + 'The test event arrives at your endpoint with the same headers + signature as a real event.' — pinned so the 202 + 3-field test-response shape + same-headers+signature survives", () => {
    expect(body).toMatch(/POST \/v1\/webhooks\/<id>\/test/);
    expect(body).toMatch(/→ 202 Accepted/);
    expect(body).toMatch(/"delivery_id": "wdl_…"/);
    // V-1485 — `event_id` was named in this arm's title and pinned by
    // nothing, which is exactly how it kept a wrong prefix while its two
    // neighbours were held correct. `delivery_id` really is `wdl_`-prefixed
    // (routes/webhooks.ts builds `wdl_${result.deliveryId}`); the event id
    // beside it is the bare column value.
    expect(body).toMatch(/"event_id": "<uuid>"/);
    expect(body).toMatch(/"event_type": "test\.ping"/);
    expect(body).toMatch(
      /The test event arrives at your endpoint with the same headers \+\s*signature as a real event\./,
    );
  });

  it("Inspecting deliveries + GET /v1/webhooks/<id>/deliveries + 'Failed deliveries surface the response status + first 200 bytes of your endpoint's response body so you can debug.' — pinned so the deliveries endpoint + 200-byte-response-body-capture survives", () => {
    expect(body).toMatch(/<code>GET \/v1\/webhooks\/&lt;id&gt;\/deliveries<\/code>/);
    expect(body).toMatch(
      /Failed deliveries surface the response status \+ first 200 bytes\s*of your endpoint's response body so you can debug\./,
    );
  });

  it("Troubleshooting 4-section framing: signatures-don't-verify (raw body + ts inside -Signature header) + auto-disabled (re-enable from dashboard) + duplicate-events expected (dedupe on -Event-Id) + missing-events (check registration includes event type) — pinned so the 4-section troubleshooting cluster survives (drift to dropping the dedupe-on-Event-Id guidance would mislead receivers about at-least-once delivery)", () => {
    expect(body).toMatch(
      /<strong>Signatures don't verify<\/strong> — confirm you're\s*hashing the <em>raw<\/em> request body, not the parsed JSON\./,
    );
    expect(body).toMatch(/<strong>Endpoint auto-disabled<\/strong>/);
    expect(body).toMatch(
      /<strong>Duplicate events<\/strong> — expected\. Dedupe on\s*<code>X-Driftstack-Event-Id<\/code>\./,
    );
    expect(body).toMatch(
      /<strong>Missing events<\/strong> — check the endpoint\s*registration includes the event type you're expecting/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
  // V-1485 — the doc claim tied to the MINT SITE, not just pinned as text.
  //
  // This page advertised `evt_…` for the webhook event id through three code
  // samples while both mint sites in `services/webhooks.ts` call a bare
  // `randomUUID()`, and a passing sentinel held the wrong claim in place. The
  // customer docs site had it right the whole time (`webhooks/events.md`
  // documents `X-Driftstack-Event-Id: <uuid>`), so the marketing page
  // contradicted the code and the other doc surface at once.
  //
  // A text pin alone would not stop the obvious wrong "fix": `api-types` really
  // does export `SessionEventIdSchema = PrefixedId('evt')`, so `evt_` looks
  // canonical to anyone who greps for it. It is for SESSION events — a different
  // record, minted nowhere — not for webhook deliveries. This arm reads the mint
  // and fails if the two ever disagree again in either direction.
  it('CRITICAL the documented webhook event id matches what the service mints. Both mint sites use a bare randomUUID(), so the page must not advertise a prefix — and if the service ever starts prefixing, this fails rather than letting the docs go stale in the other direction.', () => {
    const service = read(resolve(REPO_ROOT, 'apps/server/src/services/webhooks.ts'));
    const mints = [...service.matchAll(/const eventId = ([^;]+);/g)].map((m) => m[1]!.trim());
    expect(
      mints.length,
      'no eventId mint found in services/webhooks.ts — the scan broke, and this arm would pass having read nothing',
    ).toBeGreaterThanOrEqual(2);
    expect(
      [...new Set(mints)],
      'the webhook event id is no longer minted as a bare randomUUID() — if it is prefixed now, the marketing samples and the customer docs both need updating',
    ).toEqual(['randomUUID()']);

    // Given an unprefixed mint, the page may not claim one.
    expect(
      /X-Driftstack-Event-Id: [a-z]+_/.test(body),
      'the page advertises a prefixed event id while the service mints a bare uuid',
    ).toBe(false);
    expect(
      /"event_id": "[a-z]+_/.test(body),
      'the 202 sample advertises a prefixed event id while the service mints a bare uuid',
    ).toBe(false);
  });
  // V-1486 — the documented header set, derived from the DELIVERY code.
  //
  // The page advertised `X-Driftstack-Emitted-At` in its sample and spent a
  // paragraph on how not to misuse it. The durable dispatcher stopped sending it
  // at the cutover that moved signing to the single `t=…,v1=…` header, together
  // with `x-driftstack-signature-prev`, and
  // `durable-webhook-signature-sdk-verify` asserts both are undefined on the
  // emitted request. So a customer was being given handling advice for a header
  // that has not existed on this path since.
  //
  // The text pins above cannot see that: they compare the page to itself. This
  // reads the three delivery implementations and requires them to agree with
  // each other AND with the page, so removing a header from the code without
  // touching the docs fails here rather than in a customer's handler.
  it('CRITICAL the headers the page advertises are the headers the delivery code sends. Every delivery implementation — durable, worker and in-memory — must agree with the others and with the samples, so a header dropped in code cannot keep being documented. The set is read from the code, never listed here.', () => {
    const sources = [
      'apps/server/src/services/durable-webhook-delivery.ts',
      'apps/server/src/services/webhook-worker.ts',
      'packages/webhook-delivery/src/in-memory.ts',
    ].map((rel) => ({ rel, text: read(resolve(REPO_ROOT, rel)) }));

    const sets = sources.map(({ rel, text }) => ({
      rel,
      headers: [...new Set([...text.matchAll(/'(x-driftstack-[a-z-]+)':/g)].map((m) => m[1]!))]
        .sort()
        .join(','),
    }));
    expect(
      sets.every((x) => x.headers !== ''),
      `a delivery implementation set no x-driftstack headers — the scan broke: ${JSON.stringify(sets)}`,
    ).toBe(true);
    expect(
      [...new Set(sets.map((x) => x.headers))],
      'the three delivery implementations no longer send the same x-driftstack header set',
    ).toHaveLength(1);

    const emitted = sets[0]!.headers.split(',');
    expect(emitted.length, 'fewer than three delivery headers found').toBeGreaterThanOrEqual(3);

    // Every header the code sends must appear on the page…
    const notDocumented = emitted.filter((h) => !new RegExp(h.replace(/-/g, '-'), 'i').test(body));
    expect(notDocumented, 'header(s) the delivery sends that the page never mentions').toEqual([]);

    // …and the page must not advertise an x-driftstack request header the
    // delivery does not send. Scoped to the delivery sample block, because the
    // page legitimately names response headers elsewhere.
    const sample = /X-Driftstack-Event-Id:[\s\S]*?v1=<hex hmac>/.exec(body)?.[0] ?? '';
    expect(
      sample,
      'the delivery sample block was not found — this arm would check nothing',
    ).not.toBe('');
    const advertised = [...sample.matchAll(/(X-Driftstack-[A-Za-z-]+):/g)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(
      advertised.filter((h) => !emitted.includes(h)).sort(),
      'the delivery sample advertises a header the delivery code does not send',
    ).toEqual([]);
  });
});
