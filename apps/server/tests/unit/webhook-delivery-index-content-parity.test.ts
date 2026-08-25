// W450.A — drift guard for packages/webhook-delivery/src/index.ts.
// @driftstack/webhook-delivery public surface barrel. Drift here
// either drops a public export (consumers in apps/server +
// packages/webhook-delivery in-memory test deps get a compile-time
// break when the symbol disappears mid-refactor) or accidentally
// re-exports an internal-only helper (widens the public API surface,
// locks us into supporting a name that should never have been
// stable).
//
//   • header framing pinned.
//   • 7 type-only re-exports from ./types.js (DeliveryAttempt + Config
//     + Endpoint + Payload + Record + Status + DlqEntry).
//   • 7 interface re-exports from ./interfaces.js (DeliveryQueue +
//     DlqManager + EnqueueDeliveryOpts + ListDeliveriesOpts +
//     ListDeliveriesPage + RequeueDlqOpts + WebhookDeliveryService).
//   • MockDlqManager + MockWebhookDeliveryService from ./mock.js
//     (value exports only).
//   • in-memory exports: BACKOFF_MS_BY_ATTEMPT + DEFAULT_MAX_ATTEMPTS +
//     DEFAULT_TIMEOUT_MS + InMemoryDlqManager + InMemoryWebhook-
//     DeliveryService + createInMemoryWebhookDelivery + signPayload
//     (values) + 3 type-only InMemoryWebhookDelivery{Deps,Handles} +
//     ProcessTickResult.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webhook-delivery/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W450.A packages/webhook-delivery/src/index.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: '@driftstack/webhook-delivery public surface.'", () => {
    expect(body).toMatch(/\/\/ @driftstack\/webhook-delivery public surface\./);
  });

  it('7 type-only re-exports from ./types.js (DeliveryAttempt + DeliveryConfig + DeliveryEndpoint + DeliveryPayload + DeliveryRecord + DeliveryStatus + DlqEntry)', () => {
    expect(body).toMatch(
      /export type \{\s*DeliveryAttempt,\s*DeliveryConfig,\s*DeliveryEndpoint,\s*DeliveryPayload,\s*DeliveryRecord,\s*DeliveryStatus,\s*DlqEntry,\s*\} from '\.\/types\.js';/,
    );
  });

  it('7 interface re-exports from ./interfaces.js (DeliveryQueue + DlqManager + EnqueueDeliveryOpts + ListDeliveriesOpts + ListDeliveriesPage + RequeueDlqOpts + WebhookDeliveryService)', () => {
    expect(body).toMatch(
      /export type \{\s*DeliveryQueue,\s*DlqManager,\s*EnqueueDeliveryOpts,\s*ListDeliveriesOpts,\s*ListDeliveriesPage,\s*RequeueDlqOpts,\s*WebhookDeliveryService,\s*\} from '\.\/interfaces\.js';/,
    );
  });

  it('Mock exports from ./mock.js: MockDlqManager + MockWebhookDeliveryService (value exports only)', () => {
    expect(body).toMatch(
      /export \{ MockDlqManager, MockWebhookDeliveryService \} from '\.\/mock\.js';/,
    );
  });

  it('in-memory barrel: BACKOFF_MS_BY_ATTEMPT + DEFAULT_MAX_ATTEMPTS + DEFAULT_MAX_DLQ_ENTRIES + DEFAULT_TIMEOUT_MS constants + InMemoryDlqManager + InMemoryWebhookDeliveryService + createInMemoryWebhookDelivery + isLiteralUnsafeWebhookHost + signPayload value exports + 3 type-only InMemoryWebhookDelivery{Deps,Handles} + ProcessTickResult', () => {
    // toContain fragments (not a closed multi-line regex) so the two new
    // exports (audit fix WD-2/WD-4, 2026-07) don't break the pin.
    expect(body).toContain('export {');
    expect(body).toContain('BACKOFF_MS_BY_ATTEMPT,');
    expect(body).toContain('DEFAULT_MAX_ATTEMPTS,');
    expect(body).toContain('DEFAULT_MAX_DLQ_ENTRIES,');
    expect(body).toContain('DEFAULT_TIMEOUT_MS,');
    expect(body).toContain('InMemoryDlqManager,');
    expect(body).toContain('InMemoryWebhookDeliveryService,');
    expect(body).toContain('createInMemoryWebhookDelivery,');
    expect(body).toContain('isLiteralUnsafeWebhookHost,');
    expect(body).toContain('signPayload,');
    expect(body).toContain('type InMemoryWebhookDeliveryDeps,');
    expect(body).toContain('type InMemoryWebhookDeliveryHandles,');
    expect(body).toContain('type ProcessTickResult,');
    expect(body).toContain("} from './in-memory.js';");
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
