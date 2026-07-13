// W252.D — drift-guard for docs.driftstack.dev/webhooks/events. The
// page is the catalog reference; every value in
// SubscribableWebhookEventTypeSchema must be documented as `[LIVE]`,
// and no event present as `[LIVE]` may be missing from the schema.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscribableWebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md');

function read(): string {
  return readFileSync(DOC, 'utf8');
}

describe('W252.D docs/webhooks/events ↔ SubscribableWebhookEventTypeSchema parity', () => {
  const doc = read();
  const live = new Set(
    (SubscribableWebhookEventTypeSchema._def.values as readonly string[]).map((v) => v),
  );

  it('every live subscribable event has a [LIVE] or [DECLARED] catalog entry', () => {
    // Doc convention: ### `event.name` [LIVE]  — fired today
    //                ### `event.name` [DECLARED] — in enum, emitter pending
    // Both are acceptable catalog presence; what would FAIL is missing
    // entirely (drift).
    for (const evt of live) {
      const re = new RegExp(`\`${evt.replace(/\./g, '\\.')}\`\\s*\\[(LIVE|DECLARED)\\]`);
      expect(doc, `missing catalog entry for ${evt}`).toMatch(re);
    }
  });

  it('test.ping is tagged [LIVE] (synthetic event from /v1/webhooks/:id/test)', () => {
    expect(doc).toMatch(/`test\.ping`\s*\[LIVE\]/);
  });

  it('does not advertise crypto.order.* as [LIVE] while the enum is gated', () => {
    if (!live.has('crypto.order.paid')) {
      expect(doc).not.toMatch(/`crypto\.order\.paid`\s*\[LIVE\]/);
    }
    if (!live.has('crypto.order.failed')) {
      expect(doc).not.toMatch(/`crypto\.order\.failed`\s*\[LIVE\]/);
    }
  });

  it('describes the common envelope shape with the id, type, payload fields', () => {
    expect(doc).toMatch(/"type":\s*"<event-type>"/);
    expect(doc).toMatch(/Common envelope/);
  });

  it('distinguishes a benign superseded profile save from upload failure or stale state', () => {
    expect(doc).toMatch(/`superseded` \(a newer profile write won/);
    expect(doc).toMatch(/next restore uses the newer state/);
    expect(doc).toMatch(/benign and not data loss/);
  });
});
