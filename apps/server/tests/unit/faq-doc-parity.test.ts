// W247.B — drift-guard for /faq. Pins the concurrent-cap claims in
// the metering FAQ to TIER_CONCURRENT_SESSION_LIMITS. The page is
// the most-read pricing-context surface; drift here costs every
// pre-sale conversation.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'faq.astro');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W247.B faq doc parity', () => {
  const doc = read();

  it('concurrent-cap FAQ answer matches TIER_CONCURRENT_SESSION_LIMITS', () => {
    const t = TIER_CONCURRENT_SESSION_LIMITS;
    expect(doc).toMatch(new RegExp(`Solo Manual\\s*=\\s*${t.solo_manual.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`Team Manual\\s*=\\s*${t.team_manual.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`Agency Manual\\s*=\\s*${t.agency_manual.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`API Starter\\s*=\\s*${t.api_starter.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`API Builder\\s*=\\s*${t.api_builder.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`API Scale\\s*=\\s*${t.api_scale.toString()}\\b`));
  });

  it('says concurrency-cap exhaustion returns 429 (not 409)', () => {
    expect(doc).toMatch(/HTTP 429/);
    expect(doc).not.toMatch(/HTTP 409/);
  });

  it('trial pack uses the documented 14-day window + $0.18/hr decrement', () => {
    expect(doc).toMatch(/14 days after purchase/);
    expect(doc).toMatch(/\$0\.18 per concurrent-hour/);
  });

  it('does not assert customer-controlled egress as a shipped pricing pillar', () => {
    expect(doc).not.toMatch(/customer-controlled egress/i);
  });
});
