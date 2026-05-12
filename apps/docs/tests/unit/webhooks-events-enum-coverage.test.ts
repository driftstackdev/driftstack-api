// W310.A — drift guard for /webhooks/events coverage. Every member
// of the canonical SubscribableWebhookEventTypeSchema enum must be
// cited in the events doc page. The doc additionally lists [LIVE],
// [DECLARED], and [PLANNED] events — the contract is that every
// SUBSCRIBABLE event has a presence on the page, regardless of
// LIVE/DECLARED status.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W310.A /webhooks/events ↔ SubscribableWebhookEventType parity', () => {
  const body = read(PAGE);
  const enumValues = SubscribableWebhookEventTypeSchema.options;

  it('enum has at least 5 subscribable events (sanity)', () => {
    expect(enumValues.length).toBeGreaterThanOrEqual(5);
  });

  for (const event of SubscribableWebhookEventTypeSchema.options) {
    it(`page cites ${event}`, () => {
      // Backtick-fenced citation, table cell, or heading — any form
      // is enough.
      expect(body).toContain(event);
    });
  }

  it('page exports the canonical SubscribableWebhookEventType reference', () => {
    expect(body).toContain('SubscribableWebhookEventType');
  });
});
