import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const doc = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md'), 'utf8');

describe('docs/webhooks/events current contract parity', () => {
  it('gives every subscribable event a dedicated catalog section', () => {
    for (const event of SubscribableWebhookEventTypeSchema.options) {
      expect(doc, `missing catalog entry for ${event}`).toContain(`### \`${event}\``);
    }
  });

  it('documents test.ping as the synthetic test-endpoint event', () => {
    expect(doc).toContain('### `test.ping`');
    expect(doc).toMatch(/Synthetic test event emitted by `POST \/v1\/webhooks\/:id\/test`/);
  });

  it('contains no aspirational status taxonomy or silent quota subscription', () => {
    expect(doc).not.toMatch(/\[(?:LIVE|DECLARED|PLANNED)\]/);
    expect(doc).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
  });

  it('describes the common envelope', () => {
    expect(doc).toMatch(/"type":\s*"<event-type>"/);
    expect(doc).toContain('Common envelope');
  });

  it('distinguishes a superseded profile save from data loss', () => {
    expect(doc).toMatch(/`superseded` \(a newer profile write won/);
    expect(doc).toMatch(/next restore uses the newer state/);
    expect(doc).toMatch(/benign and not data loss/);
  });
});
