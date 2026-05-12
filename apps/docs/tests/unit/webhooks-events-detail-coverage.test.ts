// W337.A — drift guard for /webhooks/events page event-detail
// sections. Every subscribable event has a dedicated subsection
// with the event slug + status tag ([LIVE] / [DECLARED]). Pinning
// the status tag means the page can't silently flip [DECLARED] to
// [LIVE] without intentional change.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W337.A /webhooks/events detail coverage', () => {
  const body = read(PAGE);

  it('session.completed has a [LIVE] tag', () => {
    expect(body).toMatch(/### `session\.completed` \[LIVE\]/);
  });

  it('session.failed has a [LIVE] tag', () => {
    expect(body).toMatch(/### `session\.failed` \[LIVE\]/);
  });

  it('api_key.revoked has a [LIVE] tag', () => {
    expect(body).toMatch(/### `api_key\.revoked` \[LIVE\]/);
  });

  it('quota.warning_80pct is [DECLARED] (in enum, not yet wired)', () => {
    expect(body).toMatch(/### `quota\.warning_80pct` \[DECLARED\]/);
  });

  it('quota.exceeded is [DECLARED]', () => {
    expect(body).toMatch(/### `quota\.exceeded` \[DECLARED\]/);
  });

  it('test.ping is [LIVE] (always-on, dispatched by /test endpoint)', () => {
    expect(body).toMatch(/### `test\.ping` \[LIVE\]/);
  });

  it('the catalog uses status tags from a fixed taxonomy ([LIVE] / [DECLARED] / [PLANNED])', () => {
    // No rogue tags; the doc's status framing must stay narrow.
    const tagMatches = [...body.matchAll(/\[(LIVE|DECLARED|PLANNED|[A-Z_]+)\]/g)].map((m) => m[1]!);
    const tags = new Set(tagMatches);
    const offenders = [...tags].filter((t) => !['LIVE', 'DECLARED', 'PLANNED'].includes(t));
    expect(offenders).toEqual([]);
  });
});
