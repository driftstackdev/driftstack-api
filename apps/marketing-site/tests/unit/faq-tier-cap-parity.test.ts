// W261.C — drift-guard for /faq. The FAQ hardcodes the per-tier
// concurrent cap row "Personal = 1 / Team = 3 / …" so the
// cap numbers can rot when TIER_CONCURRENT_SESSION_LIMITS changes.
// Pin them to the live constants.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TIER_CONCURRENT_SESSION_LIMITS,
  PROFILES_PER_TIER,
  TIER_FEATURES,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// 2026-07-03 Fleet v2 — the Q&A array moved verbatim from faq.astro to
// src/data/faq.ts (single source for page markup + FAQPage JSON-LD).
// Path-only retarget; every assertion below is unchanged.
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/data/faq.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W261.C /faq ↔ TIER_CONCURRENT_SESSION_LIMITS parity', () => {
  const page = read(PAGE);

  it('Solo / Team / Agency + API Starter / Builder / Scale caps match the schema', () => {
    expect(page).toMatch(
      new RegExp(`Personal = ${TIER_CONCURRENT_SESSION_LIMITS.solo_manual} concurrent`),
    );
    expect(page).toMatch(new RegExp(`Team = ${TIER_CONCURRENT_SESSION_LIMITS.team_manual}\\b`));
    expect(page).toMatch(new RegExp(`Agency = ${TIER_CONCURRENT_SESSION_LIMITS.agency_manual}\\b`));
    expect(page).toMatch(
      new RegExp(`API Starter = ${TIER_CONCURRENT_SESSION_LIMITS.api_starter}\\b`),
    );
    expect(page).toMatch(
      new RegExp(`API Builder = ${TIER_CONCURRENT_SESSION_LIMITS.api_builder}\\b`),
    );
    expect(page).toMatch(new RegExp(`API Scale = ${TIER_CONCURRENT_SESSION_LIMITS.api_scale}\\b`));
  });

  it('429 cap-reached behavior is described per the live policy', () => {
    expect(page).toMatch(/HTTP 429/);
    expect(page).toMatch(/RFC 9457 problem-detail/i);
  });

  it('free-tier framing pinned: $0-forever / one concurrent / manual-only (no API) / no usage charges', () => {
    expect(page).toMatch(/The free tier is \$0 forever/);
    expect(page).toMatch(/The free tier likewise has no usage charges/);
    expect(page).toMatch(/one concurrent session is its capacity limit/);
    // Free tier is manual-only (desktop app); access from code (API/SDK)
    // starts on the API ladder. Old "API-within-free-limits" framing is
    // superseded. S20b 2026-07-06: same fact, plain words.
    expect(page).toMatch(/The free tier is manual-only \(no API\/SDK access from code\)/);
    expect(page).not.toMatch(/within the free limits/);
  });

  it('annual discount label matches the live ANNUAL_DISCOUNT_LABEL', () => {
    expect(page).toMatch(/20% off/);
  });

  it('does not hard-code legacy cap numbers (Agency 10, API Builder 5, API Scale 20)', () => {
    // Negative checks: prior drift values we already corrected in W253.D.
    expect(page).not.toMatch(/Agency = 10\b/);
    expect(page).not.toMatch(/API Builder = 5\b/);
    expect(page).not.toMatch(/API Scale = 20\b/);
  });

  it('PROFILES_PER_TIER values referenced in the FAQ match the schema', () => {
    // Free tier profile cap is 1. (Sanity bound only; FAQ may not show all numbers.)
    expect(PROFILES_PER_TIER.free).toBe(1);
  });

  it('bundled-LLM tier gating answer matches TIER_FEATURES llmBilling (Agency is BYOK-only, NOT bundled)', () => {
    // Guard against the drift fixed here: the FAQ once claimed Agency
    // supports bundled-LLM. Authoritative gating: only api_builder /
    // api_scale / enterprise carry a 'byok_or_bundled*' llmBilling; team,
    // agency, and api_starter are 'byok_only'.
    expect(TIER_FEATURES.agency_manual.llmBilling).toBe('byok_only');
    expect(TIER_FEATURES.team_manual.llmBilling).toBe('byok_only');
    expect(TIER_FEATURES.api_starter.llmBilling).toBe('byok_only');
    expect(TIER_FEATURES.api_builder.llmBilling).toBe('byok_or_bundled');
    expect(TIER_FEATURES.api_scale.llmBilling).toBe('byok_or_bundled');
    // FAQ free-text must list the BYOK-only set including Agency, and the
    // bundled set as Builder / Scale / Enterprise — never list Agency as
    // bundled-supporting.
    expect(page).toMatch(
      /Team, Agency, and API Starter are BYOK-only; API Builder, API Scale, and Enterprise support bundled-LLM with consent/,
    );
    expect(page).not.toMatch(/Agency support bundled-LLM/);
  });

  // 2026-09-16 readability pass (verifier fix). The pass gave every answer a
  // one-sentence lead, and the lead is what a hesitant buyer actually takes
  // away — so a lead that generalises a tier gate is a false answer even when
  // the body four sentences later is correct. Two leads had to be re-gated:
  //
  //   • "What is the bundled LLM?" opened "AI model access that comes with
  //     your plan" — false for team_manual / agency_manual / api_starter,
  //     which are byok_only. A Team buyer reading only the lead was told the
  //     opposite of their gate.
  //   • The concurrency answer's budget sentence had been broadened from
  //     "the optional bundled LLM" to "the optional AI assistant". The AI
  //     assistant exists on the BYOK-only tiers too, where there is no
  //     Driftstack budget at all — that usage is billed by the customer's
  //     own provider.
  //
  // Both are pinned against TIER_FEATURES here rather than by text alone, so
  // the gate can never be re-generalised without this failing.
  it('CRITICAL the bundled-LLM LEAD sentence is gated to the byok_or_bundled tiers, and the monthly budget is attributed to bundled access rather than to the AI assistant', () => {
    const bundled = (['api_builder', 'api_scale', 'enterprise'] as const).filter((t) =>
      String(TIER_FEATURES[t].llmBilling).startsWith('byok_or_bundled'),
    );
    expect(bundled, 'the bundled-capable ladder is Builder / Scale / Enterprise').toEqual([
      'api_builder',
      'api_scale',
      'enterprise',
    ]);
    // Tiers that carry the AI agent but NOT bundled access — the ones the old
    // lead silently promised bundled access to.
    for (const t of ['team_manual', 'agency_manual', 'api_starter'] as const) {
      expect(TIER_FEATURES[t].aiAgent, `${t} carries the AI agent`).toBe(true);
      expect(TIER_FEATURES[t].llmBilling, `${t} is BYOK-only`).toBe('byok_only');
    }
    expect(page).toMatch(
      /a: 'Model access Driftstack provides on API Builder, API Scale and Enterprise, so you don\\'t have to open an account with an AI provider yourself\. On Team, Agency and API Starter you bring your own key\./,
    );
    expect(page).not.toMatch(/AI model access that comes with your plan/);
    // The $0.10 monthly budget belongs to bundled access, not to the assistant.
    expect(page).toMatch(
      /The optional bundled model access on API Builder and up has a separate monthly budget of its own/,
    );
    expect(page).not.toMatch(/The optional AI assistant has a separate monthly budget/);
    // The anchor the sentence links to is the real group slug.
    expect(page).toMatch(/href="\/faq\/#bundled-llm-byok"/);
  });
});
