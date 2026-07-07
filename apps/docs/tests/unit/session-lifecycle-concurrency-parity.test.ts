// W307.A — drift guard for the session-lifecycle guide concurrency
// narrative. The guide cites two specific problem-type URIs
// (concurrency-limit, tier-limit). Both must match the live
// PROBLEM_TYPES export in @driftstack/api-types.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const GUIDE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/session-lifecycle.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W307.A session-lifecycle ↔ PROBLEM_TYPES parity', () => {
  const body = read(GUIDE);

  it('cites the canonical ConcurrencyLimit problem URI', () => {
    expect(body).toContain(PROBLEM_TYPES.ConcurrencyLimit);
  });

  it('cites the canonical TierLimit problem URI', () => {
    expect(body).toContain(PROBLEM_TYPES.TierLimit);
  });

  it('describes the destroy idempotence (concurrent slot release)', () => {
    expect(body).toMatch(/idempotent/i);
    expect(body).toMatch(/concurrent slot/i);
  });

  // S31 2026-07-07 (fable-truth-audit) — the old assertion locked a FICTIONAL contract:
  // no idle timeout exists (only the free-tier 20-min duration sweep)
  // and the webhook enum has no session.destroyed event.
  it('describes the real auto-destroy boundary: free-tier duration cap, no idle timeout, no session.destroyed event', () => {
    expect(body).toMatch(/capped at 20 minutes/);
    expect(body).toMatch(/There is no idle timeout on any tier\./);
    expect(body).not.toMatch(/session\.destroyed/);
  });

  it('frames tier concurrent caps as the only customer-visible meter', () => {
    expect(body).toMatch(/concurrent cap/i);
    // No hour caps / no overage charges — explicit pricing posture.
    expect(body).toMatch(/no hour caps/i);
    expect(body).toMatch(/no overage/i);
  });
});
