// Drift guard for apps/docs/src/pages/api/usage.md. Pins the two-
// endpoint surface (/v1/usage + /v1/usage/series), the team-RBAC
// header contract, and the 6-key UsageRecordType enum (the
// canonical metric vocabulary customers integrate against).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/usage.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/usage content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Usage/);
    expect(body).toMatch(/description: Quota counters, current-period totals/);
  });

  it('two-endpoint surface pinned: /v1/usage + /v1/usage/series — drift to a third endpoint or to dropping the series endpoint would mislead customers building dashboards', () => {
    expect(body).toMatch(/`\/v1\/usage`/);
    expect(body).toMatch(/`\/v1\/usage\/series`/);
    expect(body).toMatch(/`GET \/v1\/usage`/);
  });

  it("team-RBAC header contract pinned: X-Driftstack-Account routes the read to the OWNER usage (drift to dropping would orphan team members from the owner-quota view that's the load-bearing team-RBAC promise)", () => {
    expect(body).toMatch(/honor the `X-Driftstack-Account` header \(Team RBAC\)/);
    expect(body).toMatch(/owner's tier is\s+the quota-cap source/);
    expect(body).toMatch(/being on a team doesn't bump a member's\s+personal cap/);
  });

  it('6-key UsageRecordType enum pinned: session_minute / navigate / interact / wait / state_capture / screenshot_capture — the canonical metric vocabulary; drift to dropping any key would silently mismatch the server enum + break customer dashboards that read the totals object', () => {
    for (const key of [
      'session_minute',
      'navigate',
      'interact',
      'wait',
      'state_capture',
      'screenshot_capture',
    ]) {
      // Match either `"key": value` in the JSON example OR `` `key` `` in prose.
      expect(body, `metric key ${key}`).toMatch(new RegExp(`"${key}"|\`${key}\``));
    }
  });

  it('period_end is exclusive (first-second-of-next-month) framing pinned — drift to inclusive would create off-by-one summation bugs in any customer dashboard that sums totals across periods', () => {
    expect(body).toMatch(/period_end is exclusive — the first second of the\s+next month/);
  });
});
