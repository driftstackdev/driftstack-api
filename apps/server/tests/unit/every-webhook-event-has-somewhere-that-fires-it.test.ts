// A subscribable webhook event must have code that actually fires it.
//
// The existing coverage runs enum → docs: docs-webhooks-events-parity asserts
// every subscribable event has a catalog section in webhooks/events.md. Nothing
// ran enum → SERVER. A new event type added to the enum and written up in the
// docs would pass everything while no code path ever enqueued it, and a
// customer who subscribed would wait for a delivery that cannot arrive. That
// failure is invisible from both existing directions — the enum has it, the
// docs describe it, and only the absence of a call site says otherwise.
//
// Measured when this landed: all 8 subscribable events have an `enqueueEvent`
// site, and `test.ping` has the separate one-off dispatch its enum comment
// describes. So this protects the ninth rather than fixing any of the eight.
//
// `test.ping` is the ONE type without an enqueueEvent site, by design: it is
// not subscribable, and POST /v1/webhooks/:id/test dispatches it directly so a
// customer can verify their handler before relying on real events. That
// exception is asserted as an exact set rather than skipped, so a second
// never-enqueued type has to be a deliberate decision here.
//
// SCOPE: this proves a dispatch site EXISTS and is reachable from the event
// name, not that it fires under the right conditions. The per-event behaviour
// lives in the service tests (sessions, api-keys-service, challenge-relay,
// crypto-orders); a green here must not be read as those being covered.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { SubscribableWebhookEventTypeSchema, WebhookEventTypeSchema } from '@driftstack/api-types';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Every tracked .ts under the server's source tree. */
function serverSources(): string[] {
  return execFileSync('git', ['ls-files', 'apps/server/src'], { cwd: REPO, encoding: 'utf-8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));
}

const SOURCES = serverSources().map((f) => ({
  file: f,
  body: readFileSync(resolve(REPO, f), 'utf-8'),
}));

/** Files containing `enqueueEvent(<account>, '<type>'` — the fan-out path. */
function enqueueSites(eventType: string): string[] {
  const call = new RegExp(`enqueueEvent\\(\\s*[^,]+,\\s*'${eventType.replace(/\./g, '\\.')}'`);
  return SOURCES.filter(({ body }) => call.test(body)).map(({ file }) => file);
}

describe('every webhook event has somewhere that fires it', () => {
  it('CRITICAL the scanner reads real sources and can tell a live event from an invented one', () => {
    expect(SOURCES.length, 'no server sources found — the scan is broken').toBeGreaterThan(50);
    expect(
      SubscribableWebhookEventTypeSchema.options.length,
      'the subscribable enum is empty',
    ).toBeGreaterThanOrEqual(8);
    // Known-live and known-absent, so a pass below is not the scanner agreeing
    // with everything.
    expect(enqueueSites('session.completed').length).toBeGreaterThan(0);
    expect(enqueueSites('session.invented_for_this_test')).toEqual([]);
  });

  it('CRITICAL every subscribable event has at least one enqueue site', () => {
    const orphaned = SubscribableWebhookEventTypeSchema.options
      .filter((event) => enqueueSites(event).length === 0)
      .sort();
    expect(
      orphaned,
      'these are subscribable and documented, but no server code enqueues them — a customer who ' +
        'subscribes waits for a delivery that cannot arrive',
    ).toEqual([]);
  });

  it('CRITICAL test.ping is the only never-enqueued type, and it has its own dispatch', () => {
    const neverEnqueued = WebhookEventTypeSchema.options
      .filter((event) => enqueueSites(event).length === 0)
      .sort();
    expect(
      neverEnqueued,
      'a webhook event type has no enqueue site. If that is deliberate it needs naming here ' +
        'alongside test.ping, with the dispatch path that replaces it',
    ).toEqual(['test.ping']);

    // The replacement path: the test endpoint builds the delivery directly.
    const dispatch = SOURCES.filter(({ body }) =>
      /type: 'test\.ping' as WebhookEventType/.test(body),
    );
    expect(
      dispatch.map(({ file }) => file),
      'test.ping is exempt from the enqueue path because POST /v1/webhooks/:id/test dispatches it ' +
        'one-off — if that dispatch is gone, the exemption above is hiding a genuinely dead event',
    ).not.toEqual([]);
  });
});
