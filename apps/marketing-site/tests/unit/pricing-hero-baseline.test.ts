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
    // c24e3c307 "docs: separate subscription and usage estimates" rescoped this
    // band: the no-overage claim now covers BROWSER usage only, and the page
    // discloses that optional bundled LLM draws on a separate included-service
    // monthly budget. That is strictly MORE truthful than the old blanket
    // "No surprise overage bills" — the concurrent-only / no-hour-metering
    // promise itself is unchanged, so this guard repins onto the surviving
    // substance AND onto the compensating disclosure that makes the narrowing
    // honest. (Sibling guards pricing-page-content-parity.test.ts:141-145 and
    // apps/server/tests/unit/marketing-site-pages-pricing-content-parity.test.ts:87-91
    // were repinned in that same commit; this one was missed.)
    expect(body).toMatch(/Browser subscriptions are priced by concurrent capacity\./);
    expect(body).toMatch(/Run as many hours as you want within your concurrent cap\./);
    expect(body).toMatch(/session hours, API calls, and page navigations are unmetered within/);
    expect(body).toMatch(/No browser-usage overage bills\./);
    expect(body).toMatch(/bundled LLM uses a separate included-service monthly budget/);
  });
});
