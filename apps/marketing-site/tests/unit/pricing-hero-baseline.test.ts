// W330.B — drift guard for /pricing page hero + trial-pack card.
// Pins the headline + framing:
//   • "Two ladders. One trial pack to start." headline
//   • Manual = humans clicking GUI; API = code calling SDK
//   • Trial pack section anchored at id="trial-pack"
//   • Card uses fmtUsd(trialPack.monthlyUsd) — no inline $-literal
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

  it('headline reads "Two ladders. One trial pack to start."', () => {
    expect(body).toMatch(/Two ladders\.\s+One trial pack to start\./);
  });

  it('subhead frames Manual vs API audience split', () => {
    expect(body).toMatch(/Manual for humans clicking the GUI/);
    expect(body).toMatch(/API for code\s+calling the SDK/);
  });

  it('trial-pack section is anchored at id="trial-pack"', () => {
    expect(body).toMatch(/id="trial-pack"/);
  });

  it('trial-pack price is data-bound via fmtUsd(trialPack.monthlyUsd)', () => {
    expect(body).toMatch(/fmtUsd\(trialPack\.monthlyUsd\)/);
  });

  it('positions paid tiers as concurrent-only (no hour metering on paid)', () => {
    expect(body).toMatch(/paid tiers don't meter usage at all/i);
  });
});
