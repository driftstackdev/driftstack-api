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
import { SubscribableWebhookEventTypeSchema, WebhookEventTypeSchema } from '@driftstack/api-types';

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

// W310.B — catalog status labels ↔ emittable enum invariant.
//
// The events catalog's quick-index marks each row [LIVE], [DECLARED], or
// [PLANNED]. The page legend defines [PLANNED] as "not yet in the enum",
// so the load-bearing contract is:
//
//   { rows marked LIVE or DECLARED }  ==  WebhookEventTypeSchema  (exactly)
//   { rows marked PLANNED }           ∩   WebhookEventTypeSchema  =  ∅
//
// The W310.A coverage test only checks one direction (every SUBSCRIBABLE
// enum value is cited somewhere). It would NOT catch: a [DECLARED]/[LIVE]
// row for an event that isn't in the enum (mislabelled), a real enum event
// missing its catalog row, or a [PLANNED] row left stale after the event
// was actually added to the enum. This locks both directions to source.
describe('W310.B /webhooks/events catalog status labels ↔ WebhookEventTypeSchema', () => {
  const body = read(PAGE);
  const enumSet = new Set<string>(WebhookEventTypeSchema.options);

  // Parse the quick-index rows: | `event.name` | [STATUS] | … |
  const rowRe = /^\|\s*`([a-z_]+(?:\.[a-z_0-9]+)+)`\s*\|\s*\[(LIVE|DECLARED|PLANNED)\]/gm;
  const liveOrDeclared: string[] = [];
  const planned: string[] = [];
  for (const m of body.matchAll(rowRe)) {
    const [, event, status] = m;
    if (status === 'PLANNED') planned.push(event!);
    else liveOrDeclared.push(event!);
  }

  it('parsed a sane number of catalog rows (LIVE/DECLARED + PLANNED)', () => {
    expect(liveOrDeclared.length).toBeGreaterThanOrEqual(enumSet.size);
    expect(planned.length).toBeGreaterThanOrEqual(1);
  });

  it('every LIVE/DECLARED row is a real emittable WebhookEventType (no mislabelled phantom event)', () => {
    const notInEnum = liveOrDeclared.filter((e) => !enumSet.has(e));
    expect(
      notInEnum,
      `LIVE/DECLARED rows missing from WebhookEventTypeSchema: ${notInEnum}`,
    ).toEqual([]);
  });

  it('every emittable WebhookEventType has a LIVE/DECLARED catalog row (no undocumented event)', () => {
    const documented = new Set(liveOrDeclared);
    const undocumented = WebhookEventTypeSchema.options.filter((e) => !documented.has(e));
    expect(undocumented, `enum events with no LIVE/DECLARED row: ${undocumented}`).toEqual([]);
  });

  it('no PLANNED row is already in the enum (legend says PLANNED = not yet in the enum)', () => {
    const stale = planned.filter((e) => enumSet.has(e));
    expect(stale, `PLANNED rows that are actually in the enum (promote them): ${stale}`).toEqual(
      [],
    );
  });
});
