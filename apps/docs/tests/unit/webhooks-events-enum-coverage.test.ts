import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema, WebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const body = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md'), 'utf8');

describe('/webhooks/events ↔ emitted event contract', () => {
  it('cites every subscribable event', () => {
    for (const event of SubscribableWebhookEventTypeSchema.options) {
      expect(body, `missing subscribable event ${event}`).toContain(event);
    }
  });

  it('quick index exactly matches the emitted event enum', () => {
    const rows = [...body.matchAll(/^\|\s*`([a-z_]+(?:\.[a-z_0-9]+)+)`\s*\|/gm)].map(
      (match) => match[1]!,
    );
    expect(new Set(rows)).toEqual(new Set(WebhookEventTypeSchema.options));
  });

  it('exports the canonical subscribable-event reference and excludes silent quota values', () => {
    expect(body).toContain('SubscribableWebhookEventType');
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });
});
