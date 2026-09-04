// W244.C — drift-guard for /trust/sub-processors. The page is the
// customer-facing source of truth for Art 28(2) sub-processor amendment
// notices. This guard pins:
//
//   1. The core sub-processor list is present (Hetzner, Neon, Upstash,
//      Cloudflare R2, Postmark, Sentry, Stripe, Anthropic, NowPayments,
//      MacStadium, LiveKit, Moneybird).
//   2. The register-last-updated marker is parseable as ISO YYYY-MM-DD.
//   3. The change-log is non-empty and uses the documented `kind` enum.
//   4. The data-residency reference uses consistent region wording
//      (Sentry EU ingest, Postmark EU sending) — previously these
//      were mislabelled US. S47 2026-07-07 (founder-approved: mirror
//      deprecation): the /docs/data-residency mirror is deleted
//      (301 → docs.driftstack.io/reference/data-residency/), so
//      this clause now reads the docs successor source.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SUB_PROCESSORS,
  SUB_PROCESSOR_CHANGELOG,
  SUB_PROCESSOR_REGISTER_LAST_UPDATED,
} from '../../../marketing-site/src/data/sub-processors.ts';

const REPO = join(__dirname, '..', '..', '..', '..');
const TRUST_PAGE = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'trust',
  'sub-processors.astro',
);
// S47 2026-07-07: the docs successor of the deleted mirror page.
const RESIDENCY_PAGE = join(REPO, 'apps', 'docs', 'src', 'pages', 'reference', 'data-residency.md');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W244.C trust/sub-processors doc parity', () => {
  const page = read(TRUST_PAGE);
  const residency = read(RESIDENCY_PAGE);

  it('register includes every core sub-processor', () => {
    const names = new Set(SUB_PROCESSORS.map((sp) => sp.name));
    for (const expected of [
      'Hetzner Cloud',
      'Neon',
      'Upstash',
      'Cloudflare R2',
      'Postmark',
      'Sentry',
      'Stripe',
      'Anthropic',
      'NowPayments',
      'MacStadium',
      'LiveKit',
      'Moneybird',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('register-last-updated is a parseable ISO date', () => {
    expect(SUB_PROCESSOR_REGISTER_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const parsed = new Date(SUB_PROCESSOR_REGISTER_LAST_UPDATED).getTime();
    expect(Number.isFinite(parsed)).toBe(true);
  });

  it('change-log has at least one entry with a known kind', () => {
    expect(SUB_PROCESSOR_CHANGELOG.length).toBeGreaterThan(0);
    const validKinds = new Set(['added', 'removed', 'material_change', 'register_published']);
    for (const e of SUB_PROCESSOR_CHANGELOG) {
      expect(validKinds.has(e.kind)).toBe(true);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.effective_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('page renders the SUB_PROCESSORS table + change-log', () => {
    expect(page).toContain('SUB_PROCESSORS');
    expect(page).toContain('SUB_PROCESSOR_CHANGELOG');
  });

  it('data-residency reference (S47 docs successor) reflects the EU-region posture of Sentry + Postmark', () => {
    // Drift fix: previously these were listed as US.
    expect(residency).not.toMatch(/Sentry \(US, sentry\.io\)/);
    expect(residency).not.toMatch(/Postmark \(US\)/);
    // S47 re-pin to the docs successor's phrasing (same posture).
    expect(residency).toMatch(/Sentry, EU ingest region/);
    expect(residency).toMatch(/ingest\.de\.sentry\.io/);
    expect(residency).toMatch(/Postmark, EU sending region/);
  });

  it('cross-links between residency + sub-processors are bidirectional', () => {
    expect(residency).toMatch(/\/trust\/sub-processors|\/legal\/sub-processors/);
    expect(page).toMatch(/\/legal\/dpa/);
  });
});
