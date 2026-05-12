// W347.B — drift guard for /sessions page STATUS_BADGE_CLASS.
// The customer dashboard mirrors the same 5-status badge map that
// the admin /sessions page uses (W344.C pins the admin side).
// Both must:
//
//   1. Cover every SessionStatusSchema value (no un-styled span on
//      a new status), and
//   2. Use the canonical semantic colours (ready=emerald,
//      busy=blue, errored=red) so the customer view stays
//      consistent with the admin view.
//
// Also pins the "Sessions are the only billing meter" framing —
// the canonical ADR-004 pricing-mechanic claim.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/sessions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W347.B /sessions STATUS_BADGE_CLASS ↔ SessionStatusSchema parity', () => {
  const page = read(PAGE);
  const statuses = new Set<string>(
    (SessionStatusSchema._def as { values: readonly string[] }).values,
  );

  const block = page.match(/STATUS_BADGE_CLASS:[^={]*=?\s*\{([\s\S]*?)\};/);
  expect(block).not.toBeNull();
  const keys = [...block![1]!.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!).sort();

  it('STATUS_BADGE_CLASS keys match SessionStatusSchema exactly', () => {
    expect(keys).toEqual([...statuses].sort());
  });

  it('semantic colours: ready=emerald, busy=blue, errored=red (matches admin /sessions)', () => {
    expect(block![1]!).toMatch(/ready:\s*'[^']*emerald[^']*'/);
    expect(block![1]!).toMatch(/busy:\s*'[^']*blue[^']*'/);
    expect(block![1]!).toMatch(/errored:\s*'[^']*red[^']*'/);
  });

  it('every badge class string is unique (no copy-paste collisions)', () => {
    const classes = [...block![1]!.matchAll(/^\s*[a-z_]+:\s*'([^']+)',/gm)].map((m) => m[1]!);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('active-session filter uses creating/ready/busy semantics (live set)', () => {
    // Counted against the concurrent cap. Pin the filter so a
    // refactor can't quietly include destroyed/errored rows.
    expect(page).toMatch(/s\.status !== 'destroyed' && s\.status !== 'errored'/);
  });

  it('imports TIER_CONCURRENT_SESSION_LIMITS for the concurrent-cap meter', () => {
    expect(page).toMatch(/TIER_CONCURRENT_SESSION_LIMITS/);
    expect(page).toMatch(/from\s+['"]@driftstack\/api-types['"]/);
  });

  it('pins ADR-004 framing: sessions are the only billing meter', () => {
    expect(page).toMatch(
      /Sessions are the only billing meter — you pay for concurrent caps,\s*not duration or per-call/,
    );
  });

  it("header summary shows '<now> active · <cap> concurrent cap'", () => {
    // Pin the exact wording so a future "in-flight" or "running"
    // synonym doesn't break the SSG paint convention.
    expect(page).toMatch(/data-field="header-now"[\s\S]{0,100}active/);
    expect(page).toMatch(/data-field="header-cap"[\s\S]{0,100}concurrent cap/);
  });
});
