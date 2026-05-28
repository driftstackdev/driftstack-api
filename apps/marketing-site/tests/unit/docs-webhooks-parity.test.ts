// W346.A — drift guard for /docs/webhooks. The page is the
// authoritative customer-facing description of the webhook
// delivery contract. Constraints:
//
//   • 5 subscribable event types ↔ SubscribableWebhookEventTypeSchema
//     (test.ping is documented as a 6th non-subscribable type)
//   • Retry schedule (1m / 5m / 15m / 30m / 60m) ↔ BACKOFF_MS_BY_ATTEMPT
//   • DEFAULT_MAX_ATTEMPTS=6 ↔ "After 6 attempts → DLQ" claim
//   • DEFAULT_TIMEOUT_MS=10_000 ↔ "10 seconds" timeout claim
//   • AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES=50 ↔ "50 consecutive
//     failures → auto-disable" claim
//   • 5-minute replay tolerance (HMAC-SHA256 over t.body) — pinned
//     in the Node.js sample code
//   • 24-hour grace window on secret rotation — pinned in the
//     rotate-secret response example

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/webhooks.astro');
const WORKER = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');
const LEGACY_WORKER = resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W346.A /docs/webhooks parity', () => {
  const body = read(PAGE);
  const worker = read(WORKER);
  const legacyWorker = read(LEGACY_WORKER);

  it('EVENT_TYPES table matches SubscribableWebhookEventTypeSchema exactly', () => {
    const block = body.match(/EVENT_TYPES\s*=\s*\[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const names = [...block![1]!.matchAll(/name:\s*'([a-z0-9_.]+)'/g)].map((m) => m[1]!).sort();
    const schema = [
      ...(SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
    ].sort();
    expect(names).toEqual(schema);
  });

  it('test.ping is documented as a non-subscribable sixth event type', () => {
    expect(body).toMatch(/<code>test\.ping<\/code>[\s\S]{0,300}bypasses subscriptions/);
    const schemaEvents = new Set<string>(
      (SubscribableWebhookEventTypeSchema._def as { values: readonly string[] }).values,
    );
    expect(schemaEvents.has('test.ping')).toBe(false);
  });

  it('DEFAULT_MAX_ATTEMPTS=6 matches the "6 attempts → DLQ" claim', () => {
    expect(worker).toContain('export const DEFAULT_MAX_ATTEMPTS = 6;');
    expect(body).toMatch(/After <strong>6 attempts<\/strong>/);
  });

  it('BACKOFF_MS_BY_ATTEMPT[1..5] matches the 1m/5m/15m/30m/60m page table', () => {
    // Pin both sides. The table runs attempts 1→6 (initial + 5 retries);
    // attempt 6 uses BACKOFF[5] (the 60-min wait before the final retry).
    expect(worker).toMatch(/1:\s*60_000,/);
    expect(worker).toMatch(/2:\s*5\s*\*\s*60_000,/);
    expect(worker).toMatch(/3:\s*15\s*\*\s*60_000,/);
    expect(worker).toMatch(/4:\s*30\s*\*\s*60_000,/);
    expect(worker).toMatch(/5:\s*60\s*\*\s*60_000,/);

    expect(body).toMatch(/<td>2<\/td><td>1 minute after attempt 1<\/td>/);
    expect(body).toMatch(/<td>3<\/td><td>5 minutes after attempt 2<\/td>/);
    expect(body).toMatch(/<td>4<\/td><td>15 minutes after attempt 3<\/td>/);
    expect(body).toMatch(/<td>5<\/td><td>30 minutes after attempt 4<\/td>/);
    expect(body).toMatch(/<td>6 \(final\)<\/td><td>60 minutes after attempt 5<\/td>/);
  });

  it('DEFAULT_TIMEOUT_MS=10_000 matches the 10-second timeout claim', () => {
    expect(worker).toContain('export const DEFAULT_TIMEOUT_MS = 10_000;');
    expect(body).toMatch(/Request timeout is <strong>10 seconds<\/strong>/);
  });

  it('AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES=50 matches the auto-disable claim', () => {
    // The constant lives in the legacy webhook-worker module; pin
    // both sides regardless.
    expect(legacyWorker).toContain('AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50');
    expect(body).toMatch(/50 consecutive failures across all deliveries/);
    expect(body).toMatch(/the endpoint is auto-disabled/);
  });

  it('signature header format pinned: t=<unix-seconds>,v1=<hex hmac>', () => {
    // The page uses HTML entities for the literal `<>`; match
    // both forms so a future un-escaping pass doesn't false-fail.
    expect(body).toMatch(/t=(?:<|&lt;)unix-seconds(?:>|&gt;),v1=(?:<|&lt;)hex hmac(?:>|&gt;)/);
    expect(body).toMatch(/HMAC-SHA256\(/);
  });

  it('5-minute (300s) replay tolerance pinned in the Node.js sample', () => {
    expect(body).toMatch(/> 300\) return false/);
    expect(body).toMatch(/older than 5 minutes/);
  });

  it('secret rotation: 24-hour grace window + compound dual-v1= single header (no separate prev header)', () => {
    expect(body).toMatch(/24-hour grace window/);
    expect(body).toContain('t=…,v1=<new>,v1=<old>');
    expect(body).not.toContain('X-Driftstack-Signature-Prev');
    expect(body).toContain('grace_expires_at');
  });

  it('secret shown ONCE on create + rotate (id-prefix conventions whk_/whsec_)', () => {
    // Both response examples must surface the "shown ONCE" cue and
    // both id prefixes; secret recovery is impossible after.
    expect(body).toMatch(/shown ONCE/);
    expect(body).toMatch(/"id":\s*"whk_/);
    expect(body).toMatch(/"secret":\s*"whsec_/);
  });

  it('endpoints MUST be HTTPS (http:// rejected at registration time)', () => {
    expect(body).toMatch(/Endpoint URLs MUST be HTTPS/);
    expect(body).toMatch(/<code>http:\/\/<\/code> is rejected/);
  });

  it('SDK helpers cited for all three languages (TS / Python / Go)', () => {
    expect(body).toContain('verifyWebhookSignature');
    expect(body).toContain('verify_webhook_signature');
    expect(body).toContain('VerifyWebhookSignature');
  });
});
