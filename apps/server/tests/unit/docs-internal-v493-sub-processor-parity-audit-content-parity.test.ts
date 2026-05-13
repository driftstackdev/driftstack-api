// W565.C — drift guard for /docs/internal/v493-sub-processor-parity-audit.md.
// V-493 sub-processor parity audit 2026-05-10. Drift here either
// weakens the GDPR-Art-28(2)-30-day-notice-cadence-trigger, drops
// the F1-F5 findings taxonomy, or unsets the Tier-3-founder-only
// modification gate.
//
//   • V-493. 2026-05-10. 12 marketing × 10 DPA entries.
//   • Source A: apps/marketing-site/src/data/sub-processors.ts.
//   • Source B: docs/legal/dpa.md Annex 3.
//   • Audit modifies NEITHER source.
//   • Tier-3 founder decision required for any sub-processor list
//     change (triggers 30-day Art 28(2) notice).
//   • F1: MacStadium + LiveKit marketing-only (NOT in DPA).
//   • F2: corp-vs-data jurisdiction collapse.
//   • F3: Anthropic + NowPayments missing opt-in qualifier.
//   • F4: Postmark parent ActiveCampaign LLC missing.
//   • F5: Stripe EEA/non-EEA split lost.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v493-sub-processor-parity-audit.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W565.C /docs/internal/v493-sub-processor-parity-audit.md content parity', () => {
  const body = read(LIB);

  it("Header + 2-source + Art-28(2)-Tier-3 + 12-row side-by-side framing pinned: '# V-493 — sub-processor parity audit (2026-05-10)' + 'Audit of the parity between:' + '**Source A** (customer-facing): `apps/marketing-site/src/data/sub-processors.ts:SUB_PROCESSORS`' + '**Source B** (legal): `docs/legal/dpa.md` Annex 3 table' + 'Drift creates GDPR Article 28(2) risk' + '**This audit modifies neither source.** Any sub-processor list' + 'change is a Tier-3 founder decision because it triggers the 30-day' + 'Article 28(2) notice cadence.' + '| Hetzner Cloud — Falkenstein, Germany (EU)     | Hetzner Online GmbH — Germany — EEA-internal              | ⚠ Name mismatch (Cloud vs GmbH)' + '| Neon — Frankfurt (EU)                         | Neon, Inc. — US (corp); EU Frankfurt (data)               | ⚠ DPA distinguishes corp vs data' + '| Upstash — Frankfurt (EU)                      | Upstash, Inc. — US (corp); EU Frankfurt (data)' + '| Cloudflare R2 — EU jurisdiction               | Cloudflare, Inc. — US (corp); EU jurisdiction (data)' + '| Postmark — EU sending region                  | Postmark (ActiveCampaign LLC) — US                        | ⚠ Marketing missing legal-entity' + '| Sentry — EU region                            | Sentry (Functional Software, Inc.) — US (corp); EU (data)' + '| Stripe — Stripe Payments Europe Ltd (Ireland) | Stripe Payments Europe Ltd + Stripe, Inc. (split)' + '| Anthropic — United States (no opt-in marker)  | Anthropic, PBC (conditional, opt-in only) — US' + '| Moneybird — Netherlands (EU)                  | Moneybird B.V. — Netherlands — EEA-internal               | ✓ Aligned' + '| MacStadium — United States                    | (NOT IN DPA Annex 3)                                      | ❌ Marketing-only entry' + '| NowPayments — Estonia                         | NowPayments OU (conditional, opt-in only) — Estonia' + '| LiveKit — US                                  | (NOT IN DPA Annex 3)                                      | ❌ Marketing-only entry' — pinned so the V-493-2026-05-10 + Source-A-SUB_PROCESSORS + Source-B-dpa.md-Annex-3 + Art-28(2)-Tier-3-founder + audit-modifies-NEITHER + 12-row-side-by-side commitment survives", () => {
    expect(body).toMatch(/^# V-493 — sub-processor parity audit \(2026-05-10\)$/m);
    expect(body).toMatch(/Audit of the parity between:/);
    expect(body).toMatch(
      /\*\*Source A\*\* \(customer-facing\): `apps\/marketing-site\/src\/data\/sub-processors\.ts:SUB_PROCESSORS`/,
    );
    expect(body).toMatch(/\*\*Source B\*\* \(legal\): `docs\/legal\/dpa\.md` Annex 3 table/);
    expect(body).toMatch(/Drift creates/);
    expect(body).toMatch(/GDPR Article 28\(2\) risk/);
    expect(body).toMatch(/\*\*This audit modifies neither source\.\*\* Any sub-processor list/);
    expect(body).toMatch(/change is a Tier-3 founder decision because it triggers the 30-day/);
    expect(body).toMatch(/Article 28\(2\) notice cadence\./);
    expect(body).toMatch(
      /\| Hetzner Cloud — Falkenstein, Germany \(EU\)\s+\| Hetzner Online GmbH — Germany — EEA-internal\s+\| ⚠ Name mismatch \(Cloud vs GmbH\)/,
    );
    expect(body).toMatch(
      /\| Neon — Frankfurt \(EU\)\s+\| Neon, Inc\. — US \(corp\); EU Frankfurt \(data\)\s+\| ⚠ DPA distinguishes corp vs data/,
    );
    expect(body).toMatch(
      /\| Upstash — Frankfurt \(EU\)\s+\| Upstash, Inc\. — US \(corp\); EU Frankfurt \(data\)/,
    );
    expect(body).toMatch(
      /\| Cloudflare R2 — EU jurisdiction\s+\| Cloudflare, Inc\. — US \(corp\); EU jurisdiction \(data\)/,
    );
    expect(body).toMatch(
      /\| Postmark — EU sending region\s+\| Postmark \(ActiveCampaign LLC\) — US\s+\| ⚠ Marketing missing legal-entity/,
    );
    expect(body).toMatch(
      /\| Sentry — EU region\s+\| Sentry \(Functional Software, Inc\.\) — US \(corp\); EU \(data\)/,
    );
    expect(body).toMatch(
      /\| Stripe — Stripe Payments Europe Ltd \(Ireland\) \| Stripe Payments Europe Ltd \+ Stripe, Inc\. \(split\)/,
    );
    expect(body).toMatch(
      /\| Anthropic — United States \(no opt-in marker\)\s+\| Anthropic, PBC \(conditional, opt-in only\) — US/,
    );
    expect(body).toMatch(
      /\| Moneybird — Netherlands \(EU\)\s+\| Moneybird B\.V\. — Netherlands — EEA-internal\s+\| ✓ Aligned/,
    );
    expect(body).toMatch(
      /\| MacStadium — United States\s+\| \(NOT IN DPA Annex 3\)\s+\| ❌ Marketing-only entry/,
    );
    expect(body).toMatch(
      /\| NowPayments — Estonia\s+\| NowPayments OU \(conditional, opt-in only\) — Estonia/,
    );
    expect(body).toMatch(
      /\| LiveKit — US\s+\| \(NOT IN DPA Annex 3\)\s+\| ❌ Marketing-only entry/,
    );
  });

  it("F1-F5 findings + recommendations framing pinned: '### F1 — MacStadium + LiveKit are in the marketing list but NOT the DPA Annex 3' + '**MacStadium is real but the DPA is stale.**' + 'Triggers Art. 28(2) 30-day notice' + '**MacStadium / LiveKit are forward-looking marketing entries' + 'not yet active.**' + '### F2 — Marketing list collapses corp-vs-data jurisdiction distinctions' + 'Neon: US corp, EU Frankfurt data' + 'marketing list adds a `corporate_domicile` field' + 'No Art. 28(2) trigger' + '### F3 — Anthropic + NowPayments missing the opt-in qualifier in marketing' + 'DPA says \"conditional, opt-in only\" for both.' + 'marketing list adds an `engagement` field' + '(`always` / `conditional` / `opt_in`)' + '### F4 — Postmark's parent legal entity (ActiveCampaign LLC) not in marketing' + 'marketing list adds a `legal_entity` field for' + '### F5 — Stripe split (EEA vs non-EEA) lost in marketing' + 'DPA splits Stripe Payments Europe Ltd (EEA customers) from Stripe,' + 'Inc. (non-EEA customers)' + '`regional_split` annotation' — pinned so the F1-MacStadium+LiveKit-2-scenario (DPA-stale + forward-looking-mark-planned) + F2-corp-vs-data-corporate_domicile-field + F3-conditional-opt_in-engagement-3-value + F4-legal_entity-field-ActiveCampaign + F5-Stripe-regional_split-EEA/non-EEA commitment survives", () => {
    expect(body).toMatch(
      /### F1 — MacStadium \+ LiveKit are in the marketing list but NOT the DPA Annex 3/,
    );
    expect(body).toMatch(/\*\*MacStadium is real but the DPA is stale\.\*\*/);
    expect(body).toMatch(/Triggers Art\. 28\(2\) 30-day notice/);
    expect(body).toMatch(/\*\*MacStadium \/ LiveKit are forward-looking marketing entries/);
    expect(body).toMatch(/not yet active\.\*\*/);
    expect(body).toMatch(
      /### F2 — Marketing list collapses corp-vs-data jurisdiction distinctions/,
    );
    expect(body).toMatch(/Neon: US corp, EU Frankfurt data/);
    expect(body).toMatch(/marketing list adds a `corporate_domicile` field/);
    expect(body).toMatch(/No Art\. 28\(2\) trigger/);
    expect(body).toMatch(
      /### F3 — Anthropic \+ NowPayments missing the opt-in qualifier in marketing/,
    );
    expect(body).toMatch(/DPA says "conditional, opt-in only" for both\./);
    expect(body).toMatch(/marketing list adds an `engagement` field/);
    expect(body).toMatch(/\(`always` \/ `conditional` \/ `opt_in`\)/);
    expect(body).toMatch(
      /### F4 — Postmark's parent legal entity \(ActiveCampaign LLC\) not in marketing/,
    );
    expect(body).toMatch(/marketing list adds a `legal_entity` field for/);
    expect(body).toMatch(/### F5 — Stripe split \(EEA vs non-EEA\) lost in marketing/);
    expect(body).toMatch(/DPA splits Stripe Payments Europe Ltd \(EEA customers\) from Stripe,/);
    expect(body).toMatch(/Inc\. \(non-EEA customers\)/);
    expect(body).toMatch(/`regional_split` annotation/);
  });

  it("Tier-1 follow-up + Tier-3 follow-up + audit metadata framing pinned: '## Actionable engineering work (Tier-1 follow-up)' + 'Extend `SubProcessor` interface in' + '`apps/marketing-site/src/data/sub-processors.ts` with optional' + '`legal_entity`, `corporate_domicile`, `engagement` fields.' + 'Update `apps/marketing-site/src/pages/trust/sub-processors.astro`' + 'Add a typecheck-time invariant test that asserts every DPA' + 'Annex 3 entry has a matching marketing entry by legal_entity' + 'name (catches future drift automatically).' + '## Tier-3 follow-up (founder action)' + 'F1 (MacStadium + LiveKit DPA absence) requires a founder decision' + 'engineering does not act on F1 until founder confirms.' + '## Audit metadata' + 'Audit date: 2026-05-10' + 'Source A version: `SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-05-10'`' + 'Audit scope: 12 marketing entries × 10 DPA entries' + 'Audit tool: manual cross-reference' + 'Audit re-run cadence: pre-first-paying-customer + every Art.' + '28(2) notice + every quarter post-launch' — pinned so the Tier-1-4-step (SubProcessor-3-field + entries-update + Astro-render + typecheck-invariant-test) + Tier-3-F1-founder-decision + 12×10-audit-scope + manual-cross-ref + pre-paying-customer-Art-28(2)-quarterly-rerun-cadence commitment survives", () => {
    expect(body).toMatch(/## Actionable engineering work \(Tier-1 follow-up\)/);
    expect(body).toMatch(/1\. Extend `SubProcessor` interface in/);
    expect(body).toMatch(/`apps\/marketing-site\/src\/data\/sub-processors\.ts` with optional/);
    expect(body).toMatch(/`legal_entity`, `corporate_domicile`, `engagement` fields\./);
    expect(body).toMatch(
      /3\. Update `apps\/marketing-site\/src\/pages\/trust\/sub-processors\.astro`/,
    );
    expect(body).toMatch(/4\. Add a typecheck-time invariant test that asserts every DPA/);
    expect(body).toMatch(/Annex 3 entry has a matching marketing entry by legal_entity/);
    expect(body).toMatch(/name \(catches future drift automatically\)\./);
    expect(body).toMatch(/## Tier-3 follow-up \(founder action\)/);
    expect(body).toMatch(/F1 \(MacStadium \+ LiveKit DPA absence\) requires a founder decision/);
    expect(body).toMatch(/engineering does not act on F1 until/);
    expect(body).toMatch(/founder confirms\./);
    expect(body).toMatch(/## Audit metadata/);
    expect(body).toMatch(/- Audit date: 2026-05-10/);
    expect(body).toMatch(
      /- Source A version: `SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-05-10'`/,
    );
    expect(body).toMatch(/- Audit scope: 12 marketing entries × 10 DPA entries/);
    expect(body).toMatch(/- Audit tool: manual cross-reference/);
    expect(body).toMatch(/- Audit re-run cadence: pre-first-paying-customer \+ every Art\./);
    expect(body).toMatch(/28\(2\) notice \+ every quarter post-launch/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
