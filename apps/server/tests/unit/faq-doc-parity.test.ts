// W247.B — drift-guard for /faq. Pins the concurrent-cap claims in
// the metering FAQ to TIER_CONCURRENT_SESSION_LIMITS. The page is
// the most-read pricing-context surface; drift here costs every
// pre-sale conversation.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
// 2026-07-03 Fleet v2 — the Q&A array moved verbatim from faq.astro to
// src/data/faq.ts (single source for page markup + FAQPage JSON-LD).
// Path-only retarget; every assertion below is unchanged.
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'data', 'faq.ts');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W247.B faq doc parity', () => {
  const doc = read();

  it('concurrent-cap FAQ answer matches TIER_CONCURRENT_SESSION_LIMITS', () => {
    const t = TIER_CONCURRENT_SESSION_LIMITS;
    expect(doc).toMatch(new RegExp(`Personal\\s*=\\s*${t.solo_manual.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`Team\\s*=\\s*${t.team_manual.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`Agency\\s*=\\s*${t.agency_manual.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`API Starter\\s*=\\s*${t.api_starter.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`API Builder\\s*=\\s*${t.api_builder.toString()}\\b`));
    expect(doc).toMatch(new RegExp(`API Scale\\s*=\\s*${t.api_scale.toString()}\\b`));
  });

  it('says concurrency-cap exhaustion returns 429 (not 409)', () => {
    expect(doc).toMatch(/HTTP 429/);
    expect(doc).not.toMatch(/HTTP 409/);
  });

  it('free tier framed as $0 forever, no metering, manual-only', () => {
    expect(doc).toMatch(/The free tier is \$0 forever/);
    expect(doc).toMatch(/The free tier has no metering at all/);
    // Free tier is manual-only (GUI client). S43 2026-07-07: every
    // PAID tier includes programmatic API/SDK access (TIER_FEATURES
    // apiAccess: true across the paid ladder) — the old "starts on
    // the API ladder" framing was false and is retired. Old
    // "API-within-free-limits" framing stays superseded
    // (common.ts:76 "free $0 — manual-only (no API)").
    // S20c 2026-07-06 plain-language pass: the parenthetical reworded
    // "no programmatic API/SDK access" → "no API/SDK access from code"
    // (same server-matching fact — manual-only, no code access).
    expect(doc).toMatch(/The free tier is manual-only \(no API\/SDK access from code\)/);
    expect(doc).not.toMatch(/within the free limits/);
  });

  it('does not assert customer-controlled egress as a shipped pricing pillar', () => {
    expect(doc).not.toMatch(/customer-controlled egress/i);
  });
});
