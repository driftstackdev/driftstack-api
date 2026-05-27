// W308.B — drift guard for /faq coverage. The FAQ must cover the
// 10 canonical sections AND each section must hold at least one
// question. Catches drift where a section gets emptied during a
// pricing/positioning refactor and the page silently ships with a
// gap.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/faq.astro');

const REQUIRED_SECTIONS = [
  'Pricing model',
  'Free tier',
  'Tiers + upgrades',
  'Billing + payments',
  'Bundled LLM + BYOK',
  'EU stack + compliance',
  'Architecture + sessions',
  'Migrating from another vendor',
  'Acceptable use',
  'Support + reliability',
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W308.B /faq section + question coverage', () => {
  const body = read(PAGE);
  const titles = [...body.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]!);
  const totalQuestions = [...body.matchAll(/q:\s*'/g)].length;

  it('page contains all required section titles', () => {
    const missing = REQUIRED_SECTIONS.filter((s) => !titles.includes(s));
    expect(missing).toEqual([]);
  });

  it('page carries at least 30 questions total', () => {
    expect(totalQuestions).toBeGreaterThanOrEqual(30);
  });

  it('mentions the free-tier $0-forever framing somewhere', () => {
    // Free-tier section must include the canonical $0 framing.
    expect(body).toMatch(/\$0 forever/);
  });

  it('mentions EU stack / GDPR posture', () => {
    expect(body).toMatch(/GDPR/);
    expect(body).toMatch(/EU/);
  });
});
