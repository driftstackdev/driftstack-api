// Every metric label key registered anywhere must be enum-shaped.
//
// `services/metrics-registry.ts` states the rule in its own header:
//
//   "Label cardinality: callers MUST keep label values bounded (enum-like).
//    The registry doesn't enforce this — it would punish legitimate dynamic
//    label use — but high-cardinality labels (account_id, session_id) WILL
//    blow up the scrape size."
//
// That comment is already pinned, by `services-metrics-registry-content-parity`.
// Pinning the comment freezes what the file SAYS; it cannot notice a caller
// registering `['account_id']` tomorrow. This file checks the thing the comment
// is about.
//
// Why it is worth a guard rather than trust: the registry keys each series by a
// composite of its label VALUES in a `Map` that is never evicted. An enum-shaped
// label costs a bounded number of entries forever; one per-account or per-session
// label costs one entry per account or session, for the life of the process. The
// failure mode is not a wrong number — it is a control plane whose memory climbs
// until it is restarted, and a Prometheus scrape that grows with the customer
// base. Silent until it is an outage, and invisible to every functional test.
//
// The registry deliberately does NOT enforce this at runtime (the comment
// explains why: it would punish legitimate dynamic label use). So the enforcement
// has to live here, at the registration sites, where the keys are literals.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const REGISTRATION = /register(?:Counter|Gauge|Histogram)\s*\((.*?)\);/gs;
/** The trailing array literal of a registration call is its labelKeys. */
const TRAILING_ARRAY = /\[([^\]]*)\]\s*,?\s*$/s;

interface Registration {
  file: string;
  labelKeys: string[];
}

function collectRegistrations(): Registration[] {
  const found: Registration[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('metrics-registry.ts')) continue; // the definition itself
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(REGISTRATION)) {
      const body = match[1] ?? '';
      const arr = TRAILING_ARRAY.exec(body.trim());
      const labelKeys = arr === null ? [] : [...arr[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      found.push({ file, labelKeys });
    }
  }
  return found;
}

/**
 * Keys whose value space grows with usage rather than with the code. `_id`
 * covers the two the registry names by example; the rest are the near
 * neighbours that would cost exactly the same way.
 */
function isUnbounded(key: string): boolean {
  if (key === 'id' || key.endsWith('_id')) return true;
  return [
    'uuid',
    'email',
    'ip',
    'token',
    'url',
    'path',
    'user',
    'account',
    'session',
    'customer',
    'hash',
  ].includes(key);
}

describe('metric label cardinality', () => {
  const registrations = collectRegistrations();

  it('the scan actually finds the registration sites — a regex that matched nothing would pass every assertion below', () => {
    // Anti-vacuity. These floors are deliberately below the current counts (22
    // sites, 16 distinct keys) so ordinary additions do not trip them, while a
    // scan that silently stops matching does.
    expect(registrations.length).toBeGreaterThanOrEqual(18);
    const distinct = new Set(registrations.flatMap((r) => r.labelKeys));
    expect(distinct.size).toBeGreaterThanOrEqual(12);
  });

  it('CRITICAL no registered label key is identifier-shaped. The registry keys each series by its label VALUES in a Map that is never evicted, so one per-account or per-session label costs an entry per account for the life of the process — memory that climbs until restart and a scrape that grows with the customer base, invisible to every functional test.', () => {
    const offenders = registrations
      .flatMap((r) => r.labelKeys.map((key) => ({ key, file: r.file })))
      .filter(({ key }) => isUnbounded(key))
      .map(({ key, file }) => `${key} (${file.slice(file.indexOf('/src/') + 1)})`);
    expect(offenders).toEqual([]);
  });

  it('records the label keys in use, so adding one is a visible decision rather than a silent widening', () => {
    const distinct = [...new Set(registrations.flatMap((r) => r.labelKeys))].sort();
    // Exact, not a superset: a new key should red this and be acknowledged. The
    // arm above decides whether it is ALLOWED; this one makes it noticed.
    expect(distinct).toEqual([
      'actor_type',
      'arm',
      'bucket',
      'from',
      'job_type',
      'kind',
      'limiter',
      'method',
      'outcome',
      'prefix',
      'result_kind',
      'route',
      'status_class',
      'template',
      'terminal_state',
      'to',
    ]);
  });
});
