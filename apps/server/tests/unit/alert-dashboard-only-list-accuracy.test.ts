// The "dashboard-only" list in the alert rules says what it means.
//
// `ops/alerts/driftstack.yml` carries a comment block listing metrics that have
// no paging rule. It is the thing an engineer reads to answer "is anyone told
// when this breaks?", and it had drifted: FOUR metrics listed there as unpaged
// had real paging rules, including `rate_limit_store_fallback_total`, which has
// a `severity: critical` rule.
//
// That is not a tidiness problem. I trusted the list, concluded the limiter
// fallback was unwatched, and wrote a second critical alert for it — a
// duplicate page for the same condition, which is how alerting becomes noise
// and then gets muted. A stale list does not merely fail to inform; it actively
// misleads whoever acts on it.
//
// So the list is checked against the rules rather than maintained by hand. Both
// directions matter: a metric listed as dashboard-only must genuinely have no
// paging expression, and a metric that gains one must leave the list.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ALERTS = resolve(REPO_ROOT, 'ops/alerts/driftstack.yml');

const alertsText = (): string => readFileSync(ALERTS, 'utf8');

/**
 * Metrics referenced by an actual `expr:` — i.e. something pages or warns on
 * them. Deliberately not "mentioned anywhere in the file": every metric is
 * mentioned, because the drift guard requires it, and counting mentions would
 * make this check vacuously true.
 */
function pagedMetrics(): Set<string> {
  const out = new Set<string>();
  const text = alertsText();
  for (const block of text.matchAll(/expr: \|\n([\s\S]*?)\n\s*for:/g)) {
    for (const m of block[1]!.matchAll(/driftstack_[a-z_]+/g)) out.add(m[0]);
  }
  return out;
}

/** Metrics the comment block claims have no paging rule. */
function listedAsDashboardOnly(): Set<string> {
  const text = alertsText();
  const start = text.indexOf('Dashboard-only');
  if (start === -1) throw new Error('dashboard-only comment block not found');
  // The block runs until the first non-comment line.
  const rest = text.slice(start).split('\n');
  const out = new Set<string>();
  for (const line of rest.slice(1)) {
    if (!line.trimStart().startsWith('#')) break;
    for (const m of line.matchAll(/driftstack_[a-z_]+/g)) out.add(m[0]);
  }
  return out;
}

describe('the dashboard-only metric list matches the actual alert rules', () => {
  it('CRITICAL both sides parse to something real. If the expr scan or the comment scan came back empty, the comparisons below would compare empty sets and pass while proving nothing — which is precisely how the list went stale unnoticed.', () => {
    expect(pagedMetrics().size, 'metrics referenced by a real expr').toBeGreaterThan(5);
    expect(listedAsDashboardOnly().size, 'metrics listed as dashboard-only').toBeGreaterThan(5);
    expect([...pagedMetrics()], 'a known paged metric must survive the scan').toContain(
      'driftstack_retention_purge_total',
    );
  });

  it('CRITICAL nothing listed as dashboard-only actually pages. A stale entry does not merely fail to inform — it tells the next engineer a condition is unwatched, and the reasonable response to that is to add a second alert for something already covered.', () => {
    const paged = pagedMetrics();
    const wrong = [...listedAsDashboardOnly()].filter((m) => paged.has(m)).sort();
    expect(
      wrong,
      'metric(s) listed as having no paging rule that in fact have one — remove them from the list:',
    ).toEqual([]);
  });

  it('CRITICAL every metric without a paging rule IS listed, so the list stays a complete answer to "is anyone told when this breaks?" rather than a partial one.', () => {
    const registry = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/services/metrics-registry.ts'),
      'utf8',
    );
    const all = [...registry.matchAll(/'(driftstack_[a-z_]+)'/g)].map((m) => m[1]!);
    const paged = pagedMetrics();
    const listed = listedAsDashboardOnly();

    const missing = all.filter((m) => !paged.has(m) && !listed.has(m)).sort();
    expect(
      missing,
      'metric(s) with no paging rule and no dashboard-only entry — add them to the list:',
    ).toEqual([]);
  });
});
