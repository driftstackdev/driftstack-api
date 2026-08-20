// V-1137 — the Retryable? column in the customer error reference, against the three retry
// implementations it describes.
//
// `reference/errors.md` is where a customer learns which failures are worth retrying. Its
// table carries a `Retryable?` column, and that column is the ONLY place a raw-HTTP
// customer — one not using a first-party SDK — can learn that HTTP 429 does not mean one
// thing. Three problem types share it:
//
//   errors.driftstack.dev/rate-limited        429  transient token bucket   RETRYABLE
//   errors.driftstack.dev/concurrency-limit   429  slots in use             not retryable
//   errors.driftstack.dev/tier-limit          429  per-period quota spent   not retryable
//
// D-10 is the open question of whether a permanent cap should keep sharing 429 with
// transient throttling, and whether the problem body should carry an `upgrade_url`. That
// is a product decision and is untouched here. What is NOT a decision: while they do share
// a status, the column that distinguishes them must stay true. A client that retries a
// `tier-limit` retries something a retry can never clear — D-10's stated harm, arriving
// through documentation drift rather than by design.
//
// Neighbouring guards, checked before building this one:
//   • `errors-md-status-vs-code-parity` derives the STATUS column from `lib/errors.ts`.
//     It mentions Retryable zero times.
//   • `sdk-retry-policy-cross-sdk-parity` and `cross-sdk-retry-policy-parity` pin that the
//     three retry implementations agree with each other. They own that claim; the
//     agreement assertion below is a precondition for reading one set against the doc,
//     not a second opinion on it.
//   • V-1061's `what-the-sdks-say-they-retry-is-what-they-retry` covers prose shipped
//     INSIDE the SDK packages — `sdk-go/doc.go`, the two READMEs. It never reads
//     `apps/docs`, which is where the customer-facing table lives.
//
// So the status column is derived, the SDK-package prose is derived, the implementations
// are pinned against each other — and the column a customer actually reads to decide
// whether to retry was hand-maintained. That is the gap.
//
// Derivation note: the TypeScript predicate switches on `err.kind`, and classes reach
// their kind two different ways — `super(toOpts('<kind>', p))` for most, and a literal
// `kind: 'transport'` inside `super({...})` for TransportError. Handling only the first
// shape drops TransportError from the set, which then disagrees with Python and Go. That
// disagreement is the tell that the EXTRACTOR is wrong, not the SDK.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

function typescriptRetryable(): Set<string> {
  const src = read('packages/sdk-typescript/src/errors.ts');
  const start = src.indexOf('export function isRetryable');
  const body = src.slice(start, start + src.slice(start).indexOf('\n}'));
  const kinds = new Set([...body.matchAll(/case '(\w+)':/g)].map((m) => m[1] ?? ''));

  const out = new Set<string>();
  for (const m of src.matchAll(
    /export class (\w+) extends DriftstackError \{([\s\S]{0,900}?)\n\}/g,
  )) {
    const block = m[2] ?? '';
    const kind = /toOpts\('(\w+)'/.exec(block) ?? /kind: '(\w+)'/.exec(block);
    if (kind !== null && kinds.has(kind[1] ?? '')) out.add(m[1] ?? '');
  }
  return out;
}

function pythonRetryable(): Set<string> {
  const src = read('packages/sdk-python/src/driftstack/errors.py');
  const m = /_RETRYABLE_TYPES[^=]*=\s*\(([^)]*)\)/.exec(src);
  expect(m, 'the Python _RETRYABLE_TYPES tuple moved').not.toBeNull();
  return new Set(
    (m?.[1] ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.endsWith('Error')),
  );
}

function goRetryable(): Set<string> {
  const src = read('packages/sdk-go/errors.go');
  const start = src.indexOf('func IsRetryable');
  const body = src.slice(start, start + src.slice(start).indexOf('\n}'));
  return new Set([...body.matchAll(/var \w+ \*(\w+)/g)].map((m) => m[1] ?? ''));
}

interface DocRow {
  label: string;
  cls: string;
  retryable: boolean;
}

function docRows(): DocRow[] {
  const out: DocRow[] = [];
  for (const line of read('apps/docs/src/pages/reference/errors.md').split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    const cls = (cells[2] ?? '').replace(/`/g, '');
    // The TypeScript column is a bare class name on data rows and prose on the
    // header/separator, which is what separates them without counting rows.
    if (!/^\w+$/.test(cls)) continue;
    out.push({
      label: cells[0] ?? '',
      cls,
      retryable: (cells[cells.length - 1] ?? '').toLowerCase().includes('yes'),
    });
  }
  return out;
}

describe('V-1137 the Retryable? column matches what the SDKs retry', () => {
  // The comparison below is by CLASS NAME, and that is load-bearing in a way worth
  // stating: the three SDKs do NOT name every error class alike. The reference table's
  // own row for `tier-limit` reads `TierLimitError` in TypeScript and
  // `QuotaExceededError` in Python. The three RETRYABLE classes do share names across
  // all three SDKs, which is what makes a name comparison meaningful here — and
  // `docs/architecture/sdk-versioning.md` requires exactly that of the error hierarchy.
  // If a future SDK renames one of the three, this arm fails for a naming reason rather
  // than a behavioural one; that is the correct outcome, because the lockstep naming is
  // itself the policy, but the failure message should be read with this in mind.
  it('CRITICAL the three SDK retry implementations still agree on one set. Owned by the cross-SDK retry guards, asserted here only because the arm below reads ONE derived set against the customer-facing column — if they diverged, comparing the doc to any single SDK would be checking the wrong thing while looking green.', () => {
    const ts = [...typescriptRetryable()].sort();
    const py = [...pythonRetryable()].sort();
    const go = [...goRetryable()].sort();
    expect(ts.length, 'no retryable classes derived from the TypeScript predicate').toBeGreaterThan(
      0,
    );
    expect(py, 'Python disagrees with TypeScript on the retryable set').toEqual(ts);
    expect(go, 'Go disagrees with TypeScript on the retryable set').toEqual(ts);
  });

  it('CRITICAL every row of the customer error reference marks retryability the way the SDKs implement it. This column is the only place a raw-HTTP customer learns that 429 is three different conditions, one of which no retry can clear.', () => {
    const retryable = typescriptRetryable();
    const rows = docRows();

    // Anti-vacuity by name rather than by count: a parse that silently yielded nothing
    // would report the whole table honest. These two rows are the ones the finding is
    // about and cannot leave the table while the errors exist.
    const labels = rows.map((r) => r.cls);
    expect(labels, 'no rows parsed — the reference table shape moved').toContain('RateLimitError');
    expect(labels, 'the tier-limit row left the table').toContain('TierLimitError');

    const wrong = rows
      .filter((r) => retryable.has(r.cls) !== r.retryable)
      .map((r) => `${r.cls} (${r.label}): doc says ${r.retryable ? 'yes' : 'no'}`);
    expect(wrong.sort(), 'Retryable? cells that disagree with the SDK predicates').toEqual([]);
  });

  it('CRITICAL the three 429 problem types are still three, and still split on retryability. If a future change collapses them, or makes a permanent cap retryable, this is the arm that should be argued with rather than edited — it is the shape D-10 is deciding about.', () => {
    const errors = read('apps/server/src/lib/errors.ts');
    const with429 = [
      ...errors.matchAll(/export class (\w+) extends ApiError \{[\s\S]{0,700}?status: (\d{3})/g),
    ]
      .filter((m) => m[2] === '429')
      .map((m) => m[1] ?? '');
    expect(with429.sort(), 'the set of 429-carrying error classes changed').toEqual([
      'ConcurrencyLimitError',
      'RateLimitedError',
      'TierLimitError',
    ]);

    const retryable = typescriptRetryable();
    expect(retryable.has('RateLimitError'), 'transient throttling stopped being retryable').toBe(
      true,
    );
    expect(retryable.has('TierLimitError'), 'a per-period quota became retryable').toBe(false);
    expect(retryable.has('ConcurrencyLimitError'), 'the concurrency cap became retryable').toBe(
      false,
    );
  });
});
