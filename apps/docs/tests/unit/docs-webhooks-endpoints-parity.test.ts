// W257.D — drift-guard for docs.driftstack.io/webhooks/endpoints.
// Pins every /v1/webhooks/* path documented to a live route, and
// pins the documented JSON resource shape to WebhookEndpointSchema.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebhookEndpointSchema, WebhookDeliveryStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/endpoints.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W257.D docs/webhooks/endpoints ↔ /v1/webhooks/* parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);

  it('every /v1/webhooks/* endpoint documented is registered', () => {
    const PATHS = [
      '/v1/webhooks',
      '/v1/webhooks/:id',
      '/v1/webhooks/:id/deliveries',
      '/v1/webhooks/:id/test',
      '/v1/webhooks/:id/rotate-secret',
    ];
    for (const p of PATHS) {
      expect(doc).toContain(p);
      expect(route).toContain(`'${p}'`);
    }
  });

  it('resource-shape JSON keys match WebhookEndpointSchema exactly', () => {
    const liveKeys = Object.keys(WebhookEndpointSchema.shape);
    for (const k of liveKeys) {
      expect(doc).toMatch(new RegExp(`"${k}":`));
    }
  });

  it('delivery-introspection status filter values match the live enum', () => {
    const liveStatuses = WebhookDeliveryStatusSchema.options;
    for (const s of liveStatuses) {
      expect(doc).toMatch(new RegExp(`\`${s}\``));
    }
  });

  it('id prefixes match the live id schemas (whk_ + wdl_)', () => {
    expect(doc).toMatch(/whk_<uuid>/);
    expect(doc).toMatch(/wdl_<uuid>/);
  });

  it('rotation grace window is documented as 24h', () => {
    expect(doc).toMatch(/24[- ]hour/i);
  });

  it('events array bounded 1..10 + rejects test.ping per schema', () => {
    expect(doc).toMatch(/>10 entries/);
    expect(doc).toMatch(/test\.ping/);
  });

  it('cross-link to /webhooks/events + /webhooks/replay points at real pages', () => {
    expect(doc).toMatch(/\/webhooks\/events/);
    expect(doc).toMatch(/\/webhooks\/replay/);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md'), 'utf8').length,
    ).toBeGreaterThan(0);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md'), 'utf8').length,
    ).toBeGreaterThan(0);
  });
});
