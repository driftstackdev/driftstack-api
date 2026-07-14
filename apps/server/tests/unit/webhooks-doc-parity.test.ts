// W213.B — drift-guard parity test.
//
// Pins the /docs/webhooks marketing-site page to the canonical
// constants + wire format the server actually uses. The webhook
// docs are the most-read external surface for the SDK + ops
// integration story; when they drift, customer integrations break
// silently because the doc's example verification code uses a
// header that doesn't exist.
//
// Source files this test guards:
//   - apps/server/src/lib/webhook-signing.ts
//       → outbound signature header shape ("t=<ts>,v1=<hex>")
//   - apps/server/src/services/durable-webhook-delivery.ts
//       → DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS,
//         BACKOFF_MS_BY_ATTEMPT, header names
//   - apps/server/src/services/webhook-worker.ts
//       → AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES
//   - apps/server/src/db/schema.ts
//       → webhook_event_type enum
//   - apps/server/src/routes/webhooks.ts
//       → endpoint id prefix ("whk_") + rotate response shape

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';
import {
  BACKOFF_MS_BY_ATTEMPT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
} from '../../src/services/durable-webhook-delivery.js';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'webhooks.astro');
const WORKER_PATH = join(REPO, 'apps', 'server', 'src', 'services', 'webhook-worker.ts');
const SIGNING_PATH = join(REPO, 'apps', 'server', 'src', 'lib', 'webhook-signing.ts');
const ROUTES_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'webhooks.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W213.B webhooks doc parity', () => {
  const doc = read(DOC_PATH);

  it('signature header shape mentions t=...,v1=... (Stripe-style, not bare v1=)', () => {
    expect(doc).toMatch(/t=&lt;unix-seconds&gt;,v1=&lt;hex hmac&gt;/);
    // And rule out the previous-doc shape:
    expect(doc).not.toMatch(/X-Driftstack-Signature: v1=hmac-sha256-hex/);
    // And confirm the source-of-truth uses Stripe-style:
    expect(read(SIGNING_PATH)).toMatch(/t=\$\{t\.toString\(\)\}/);
  });

  it('no mention of the nonexistent X-Driftstack-Timestamp header', () => {
    expect(doc).not.toMatch(/X-Driftstack-Timestamp/i);
    expect(doc).not.toMatch(/x-driftstack-timestamp/);
  });

  it('event-type header is X-Driftstack-Event-Type, not bare X-Driftstack-Event', () => {
    expect(doc).toMatch(/X-Driftstack-Event-Type/);
    // The doc should not say "X-Driftstack-Event:" (with colon — the
    // bare-event header that doesn't exist). Allow X-Driftstack-Event-Id
    // and X-Driftstack-Event-Type.
    const offending = doc.match(/X-Driftstack-Event:[^-]/);
    expect(offending).toBeNull();
  });

  it('emitted-at header is the informational one we actually send', () => {
    expect(doc).toMatch(/X-Driftstack-Emitted-At/);
  });

  it('retry schedule matches BACKOFF_MS_BY_ATTEMPT to the minute', () => {
    // Source-of-truth: 1 min, 5 min, 15 min, 30 min, 60 min.
    expect(BACKOFF_MS_BY_ATTEMPT[1]).toBe(60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[2]).toBe(5 * 60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[3]).toBe(15 * 60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[4]).toBe(30 * 60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[5]).toBe(60 * 60_000);
    // The doc lists attempts 1→6: the initial try plus 5 retries with
    // backoff applied between them (1/5/15/30/60 min). All five backoff
    // entries are used; the 5th (60 min) schedules the final retry
    // before DLQ.
    expect(doc).toMatch(/1 minute/);
    expect(doc).toMatch(/5 minutes/);
    expect(doc).toMatch(/15 minutes/);
    expect(doc).toMatch(/30 minutes/);
    expect(doc).toMatch(/60 minutes/);
    // Rule out the stale schedule:
    expect(doc).not.toMatch(/30s, 2m, 10m, 1h, 6h, 24h/);
  });

  it('max-attempts claim matches DEFAULT_MAX_ATTEMPTS', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(6);
    expect(doc).toMatch(/After <strong>6 attempts<\/strong>/);
    // Rule out the stale 5-attempt (4-retry) claim:
    expect(doc).not.toMatch(/After <strong>5 attempts<\/strong>/);
  });

  it('timeout claim matches DEFAULT_TIMEOUT_MS', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(doc).toMatch(/10 seconds/);
  });

  it('auto-disable threshold matches webhook-worker constant', () => {
    const worker = read(WORKER_PATH);
    const m = worker.match(/AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const threshold = Number(m![1]);
    expect(threshold).toBe(50);
    expect(doc).toMatch(new RegExp(`${threshold} consecutive failures`));
    // Rule out the stale claim:
    expect(doc).not.toMatch(/10 consecutive failures/);
  });

  it('rotation pattern: both HMACs in ONE comma-separated v1= header, not a separate -Prev header', () => {
    // The server emits t=…,v1=<new>,v1=<old> in the single
    // x-driftstack-signature header; no separate prev header exists.
    expect(doc).toContain('t=…,v1=<new>,v1=<old>');
    expect(doc).not.toMatch(/X-Driftstack-Signature-Prev/);
  });

  it('endpoint id prefix in examples is whk_, not wh_', () => {
    expect(read(ROUTES_PATH)).toMatch(/id: `whk_\$\{/);
    // Look for stale `"id": "wh_…"` literals in the doc.
    expect(doc).not.toMatch(/"id":\s*"wh_/);
    expect(doc).toMatch(/"id":\s*"whk_/);
  });

  it('secret format is whsec_<chars>, not the stale whsec_v1_<chars>', () => {
    expect(doc).not.toMatch(/whsec_v1_/);
    expect(doc).toMatch(/whsec_/);
  });

  it('event-type table matches the current customer-subscribable schema', () => {
    const customerFacing = SubscribableWebhookEventTypeSchema.options;
    expect(customerFacing.length).toBeGreaterThan(0);
    for (const v of customerFacing) {
      expect(doc).toContain(v);
    }
    // test.ping must still be acknowledged on the page so customers
    // know it exists when reading the testing section.
    expect(doc).toMatch(/test\.ping/);
    expect(doc).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  it('rotate-secret response field name is grace_expires_at', () => {
    expect(read(ROUTES_PATH)).toMatch(/grace_expires_at:/);
    expect(doc).toMatch(/grace_expires_at/);
    // Rule out the stale field name:
    expect(doc).not.toMatch(/previous_secret_expires_at/);
  });
});
