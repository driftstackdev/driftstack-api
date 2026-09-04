// W340.C — drift guard for admin /incidents page badge taxonomy.
// Two badge maps (SEVERITY_BADGE + STATUS_BADGE) hard-code the
// IncidentSeverity / IncidentStatus enums; both must stay in sync
// with the server-side IncidentSeveritySchema + IncidentStatusSchema.
// Otherwise a new enum value (e.g. 'postmortem_pending') ships
// without a badge class and the page renders an un-styled span.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncidentSeveritySchema, IncidentStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W340.C admin /incidents badge taxonomy parity', () => {
  const page = read(PAGE);

  const severities = new Set<string>(
    (IncidentSeveritySchema._def as { values: readonly string[] }).values,
  );
  const statuses = new Set<string>(
    (IncidentStatusSchema._def as { values: readonly string[] }).values,
  );

  const sevMatch = page.match(/const SEVERITY_BADGE(?:\s*:[^=]+)?\s*=\s*\{([\s\S]*?)\};/);
  const statMatch = page.match(/const STATUS_BADGE(?:\s*:[^=]+)?\s*=\s*\{([\s\S]*?)\};/);

  it('SEVERITY_BADGE + STATUS_BADGE blocks are present in the page', () => {
    expect(sevMatch).not.toBeNull();
    expect(statMatch).not.toBeNull();
  });

  function keysOf(block: string): string[] {
    return [...block.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!).sort();
  }

  it('SEVERITY_BADGE keys match IncidentSeveritySchema exactly', () => {
    const keys = keysOf(sevMatch![1]!);
    expect(keys).toEqual([...severities].sort());
  });

  it('STATUS_BADGE keys match IncidentStatusSchema exactly', () => {
    const keys = keysOf(statMatch![1]!);
    expect(keys).toEqual([...statuses].sort());
  });

  it('every severity badge has a unique Tailwind class string (no copy-paste collisions)', () => {
    const classes = [...sevMatch![1]!.matchAll(/^\s*[a-z_]+:\s*'([^']+)',/gm)].map((m) => m[1]!);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('outage severity uses red (highest-urgency colour, matches status-page convention)', () => {
    expect(sevMatch![1]!).toMatch(/outage:\s*'[^']*red[^']*'/);
  });

  it('resolved status uses emerald/green (positive resolution colour)', () => {
    expect(statMatch![1]!).toMatch(/resolved:\s*'[^']*emerald[^']*'/);
  });

  it('page pins the "~60 seconds" status-page propagation claim (V-338 SSE freshness)', () => {
    // Customer-facing claim: public incidents surface on
    // status.driftstack.io within ~60s. Pin it so a copy revamp
    // doesn't silently move the goalposts.
    expect(page).toMatch(/within ~60 seconds/);
  });

  it('"Every action audit-logged" transparency cue is preserved', () => {
    expect(page).toMatch(/Every action audit-logged/);
  });
});
