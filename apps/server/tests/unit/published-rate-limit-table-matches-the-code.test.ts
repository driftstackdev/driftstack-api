// The per-tier rate-limit table customers read is the table the limiter
// enforces — every number, compared as a number.
//
// `reference/rate-limits.md` publishes eight tiers against six numeric columns:
// capacity and refill for `global`, `sessions:create` and
// `agent_sessions:message`. Forty-eight figures, and customers size their
// concurrency and backoff on them.
//
// What already guards that page is real but orthogonal. `rate-limits-doc-bucket-parity`
// checks the bucket NAMES against the live defaults, and it exists because the
// page once listed `sessions:start`, `sessions:read` and `profiles:write` —
// buckets that do not exist — so readers built retry policies for limits that
// never fire. `v219-rate-limit-defaults-parity` pins the constant's own source
// text. Neither reads the published numbers.
//
// So the same shape as the webhook backoff schedule: names covered, values not.
// Changing `api_scale` global capacity in `common.ts` and updating the v219 pin
// alongside it — the natural way to make that change — leaves the page
// promising the old figure with nothing failing. A customer sizing a burst
// against a published 6,000 when the limiter allows 8,000 is merely
// conservative; the reverse ships 429s they planned around.
//
// Refill is published as a fraction with a gloss — `1/60 (1 per minute)` — and
// capacity with thousands separators. Both are parsed to numbers rather than
// string-matched, because the point is the value and not the spelling: a page
// rewritten to say `0.0167` instead of `1/60` is still correct and must stay
// green, while one that says `1/30` must not.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'docs',
  'src',
  'pages',
  'reference',
  'rate-limits.md',
);

/** Columns of the published table, in order, mapped to the bucket they state. */
const COLUMNS: {
  bucket: 'global' | 'sessions:create' | 'agent_sessions:message';
  field: 'capacity' | 'refill_per_second';
}[] = [
  { bucket: 'global', field: 'capacity' },
  { bucket: 'global', field: 'refill_per_second' },
  { bucket: 'sessions:create', field: 'capacity' },
  { bucket: 'sessions:create', field: 'refill_per_second' },
  { bucket: 'agent_sessions:message', field: 'capacity' },
  { bucket: 'agent_sessions:message', field: 'refill_per_second' },
];

/**
 * Read one published cell as a number.
 *
 * Handles `1,800`, `1/60 (1 per minute)` and a bare `2`. The parenthetical
 * gloss is dropped before parsing — it restates the fraction in per-minute
 * terms for readers and is not a second value.
 */
function cellValue(raw: string): number {
  const cleaned = raw
    .replace(/\(.*?\)/g, '')
    .replace(/,/g, '')
    .trim();
  const fraction = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(cleaned);
  if (fraction !== null) return Number(fraction[1]) / Number(fraction[2]);
  return Number(cleaned);
}

interface Published {
  tier: string;
  values: number[];
}

/** The published table, as rows of numbers keyed by tier. */
function publishedRows(): Published[] {
  const md = readFileSync(DOC, 'utf8');
  const rows: Published[] = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*`([a-z_]+)`\s*\|(.+)\|\s*$/.exec(line);
    if (m === null) continue;
    const cells = (m[2] ?? '').split('|').map((c) => c.trim());
    if (cells.length < COLUMNS.length) continue;
    rows.push({ tier: m[1]!, values: cells.slice(0, COLUMNS.length).map(cellValue) });
  }
  return rows;
}

describe('the published rate-limit table matches the limiter', () => {
  it('CRITICAL the page parsed into real rows of real numbers. The comparison below reports disagreement, so a parse that produced no rows — a reformatted table, a renamed tier column — would report the whole table verified having read none of it.', () => {
    const rows = publishedRows();
    expect(rows.length, 'tier rows parsed from the published table').toBe(
      Object.keys(TIER_RATE_LIMIT_DEFAULTS).length,
    );
    expect(
      rows.filter((r) => r.values.some((v) => !Number.isFinite(v))).map((r) => r.tier),
      'row(s) with a cell that did not parse to a number:',
    ).toEqual([]);

    // The two awkward spellings, on cells whose answer is not in doubt. A
    // reader that returned NaN for these would fail above; one that returned
    // the numerator only would agree with nothing and is caught here.
    expect(cellValue('1,800'), 'thousands separators are stripped').toBe(1800);
    expect(cellValue('1/60 (1 per minute)'), 'a fraction with a gloss is a fraction').toBeCloseTo(
      1 / 60,
      10,
    );
  });

  it('CRITICAL every tier the limiter knows appears in the published table. A tier missing from the page is a customer with no published limits at all, which is worse than a wrong number because there is nothing to be wrong.', () => {
    const published = new Set(publishedRows().map((r) => r.tier));
    expect(
      Object.keys(TIER_RATE_LIMIT_DEFAULTS)
        .filter((t) => !published.has(t))
        .sort(),
      'tier(s) enforced but not documented:',
    ).toEqual([]);
  });

  it('CRITICAL every published number equals what the limiter enforces. The existing guards check the bucket NAMES on this page and pin the constant to its own source text; nothing reads these figures and holds them against the code, so a coordinated change leaves the page promising the old limits and everything green.', () => {
    const defaults = TIER_RATE_LIMIT_DEFAULTS as Record<
      string,
      Record<string, { capacity: number; refill_per_second: number }>
    >;
    const wrong: string[] = [];
    for (const row of publishedRows()) {
      const tier = defaults[row.tier];
      if (tier === undefined) continue;
      COLUMNS.forEach((col, i) => {
        const actual = tier[col.bucket]?.[col.field];
        const claimed = row.values[i];
        if (actual === undefined || claimed === undefined) return;
        // Refills are fractions; compare with tolerance rather than identity.
        const agrees =
          col.field === 'capacity' ? actual === claimed : Math.abs(actual - claimed) < 1e-9;
        if (!agrees) {
          wrong.push(
            `${row.tier} ${col.bucket} ${col.field}: page says ${String(claimed)}, limiter uses ${String(actual)}`,
          );
        }
      });
    }
    expect(wrong.sort(), 'published rate-limit figure(s) the limiter does not enforce:').toEqual(
      [],
    );
  });
});
