// W330.B — drift guard for /pricing page hero + free-tier card.
// Pins the headline + framing:
//   • "Two ladders. One free tier to start." headline
//   • Manual = humans clicking GUI; API = code calling SDK
//   • Free-tier section anchored at id="free"
//   • Card uses fmtUsd(freeTier.monthlyUsd) — no inline $-literal
//     for the price (data-bound)
//   • Paid tiers are concurrent-only (no hour metering)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W330.B /pricing hero baseline', () => {
  const body = read(PAGE);

  it('headline reads "Two ladders. One free tier to start." — split into two spans by the hero-glow visual treatment; check each phrase independently.', () => {
    expect(body).toMatch(/Two ladders\./);
    expect(body).toMatch(/One free tier to start\./);
  });

  it('subhead frames Manual vs API audience split', () => {
    // W499 — assert the on-page hero subhead (stable), not the meta description
    // (whose jargon was rewritten noob-friendly this wave).
    expect(body).toMatch(/if a person is driving\s*\n?\s*sessions in our desktop app/);
    expect(body).toMatch(/if your code is calling\s*\n?\s*the SDK/);
  });

  it('free-tier section is anchored at id="free"', () => {
    expect(body).toMatch(/id="free"/);
  });

  it('free-tier price is data-bound via fmtUsd(freeTier.monthlyUsd)', () => {
    expect(body).toMatch(/fmtUsd\(freeTier\.monthlyUsd\)/);
  });

  it('positions usage as concurrent-only (no hour metering)', () => {
    expect(body).toMatch(/Pay per concurrent session/);
    expect(body).toMatch(/is unmetered/);
  });
});
