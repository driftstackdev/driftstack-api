// Repository-level webhook catalog parity.
//
// The rendered docs page is the customer-facing source. The root catalog is kept
// byte-for-byte equal to its Markdown body so internal architecture links cannot
// drift back to roadmap events, retired envelopes, or obsolete rotation advice.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubscribableWebhookEventTypeSchema, WebhookEventTypeSchema } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROOT_CATALOG = resolve(REPO_ROOT, 'docs/api/webhook-events.md');
const RENDERED_SOURCE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function markdownBody(source: string): string {
  return source.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\n/, '');
}

describe('root webhook-event catalog parity', () => {
  const root = read(ROOT_CATALOG);
  const rendered = markdownBody(read(RENDERED_SOURCE));
  const emitted = WebhookEventTypeSchema.options;
  const subscribable = SubscribableWebhookEventTypeSchema.options;

  it('is an exact mirror of the rendered customer reference', () => {
    expect(root).toBe(rendered);
  });

  it('lists every emitted event and only the current subscription set', () => {
    expect(emitted).toHaveLength(9);
    expect(subscribable).toHaveLength(8);

    for (const eventType of emitted) {
      expect(root).toContain(`\`${eventType}\``);
    }
    for (const eventType of subscribable) {
      expect(root).toMatch(new RegExp(`\\"?${eventType.replaceAll('.', '\\.')}\\"?`));
    }

    expect(emitted).toContain('test.ping');
    expect(subscribable).not.toContain('test.ping');
    expect(root).toContain('Customers cannot subscribe to `test.ping`');
    expect(root).not.toMatch(/quota\.(?:warning_80pct|exceeded)/);
  });

  it('pins the live envelope, signing, delivery, and rotation contracts', () => {
    expect(root).toContain('"id": "<uuid>"');
    expect(root).toContain('"type": "<event-type>"');
    expect(root).toContain('"created_at": "2026-05-05T12:34:56.789Z"');
    // Prettier 3.8.3 broke the inline `{/* ... */}` onto separate lines. The
    // promise is that the envelope documents a per-event-type `data` object, so
    // the two halves are asserted rather than one exact rendering of them.
    expect(root).toContain('"data": {');
    expect(root).toContain('per-event-type shape, see below');
    expect(root).not.toMatch(/"(?:account_id|emitted_at)":/);

    expect(root).toContain('X-Driftstack-Signature: t=<unix-seconds>,v1=<hex>');
    expect(root).toContain('HMAC-SHA256(`<t>.<raw body>`)');
    expect(root).toContain('X-Driftstack-Event-Id: <uuid>');
    expect(root).toContain('X-Driftstack-Event-Type: <event-type>');
    expect(root).toContain('6 attempts (the initial delivery plus 5 retries)');
    expect(root).toContain('1m, 5m, 15m, 30m, 60m');
    expect(root).toContain('POST /v1/webhooks/:id/rotate-secret');
    expect(root).toContain('24-hour grace window');
  });

  it('contains no roadmap, placeholder, or internal ticket vocabulary', () => {
    expect(root).not.toMatch(/\[(?:PLANNED|DECLARED)\]/);
    expect(root).not.toMatch(/\b(?:V-NNN|when it lands|will emit|not wired|coming soon)\b/i);
    expect(root).not.toMatch(/delete \+ re-create the endpoint/i);
  });
});
