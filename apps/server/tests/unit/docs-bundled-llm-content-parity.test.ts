// Arc 6 docs.bundled-llm — drift guard for the new
// /api/bundled-llm docs page.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/bundled-llm.md');

describe('Arc 6 docs.bundled-llm content parity', () => {
  it('page exists at the expected path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const body = readFileSync(PAGE, 'utf8');

  it('frontmatter declares layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Bundled LLM/);
    expect(body).toMatch(/description: .+monthly soft cap/);
  });

  it('explains the opt-in consent + BYOK-wins resolution chain (slice 151 added markdown link to /api/byok-anthropic/; regex tolerates both bare-BYOK and [BYOK](...) forms and the post-reflow whitespace shape)', () => {
    expect(body).toMatch(/Opt-in is explicit/);
    // Match either `prefers BYOK` or `prefers [BYOK](/api/byok-anthropic/)`.
    expect(body).toMatch(/prefers \[?BYOK\]?/);
    // Allow newline between "is" and "the" (post-link prose-reflow).
    expect(body).toMatch(/bundled-LLM is\s+the no-BYOK fallback/);
  });

  it('documents all three customer endpoints', () => {
    expect(body).toMatch(/GET \/v1\/account\/me\/bundled-llm-settings/);
    expect(body).toMatch(/GET \/v1\/account\/me\/bundled-llm-status/);
    expect(body).toMatch(/PATCH \/v1\/account\/me\/bundled-llm-settings/);
  });

  it('cap ceiling pinned at $10,000 (1_000_000 cents) — matches schema constraint', () => {
    expect(body).toMatch(/1,000,000.*\$10,000/);
  });

  it('default cap pinned at $20 (2000 cents)', () => {
    expect(body).toMatch(/monthly_cap_usd_cents.*2000/);
  });

  it('documents live desktop controls and exact flat standard bundled billing', () => {
    expect(body).toMatch(/Settings → AI[\s\S]*?& billing/);
    // The flat rate is the load-bearing customer claim; the page states it as
    // an included-service accounting value (a budget, not an itemized Stripe
    // line), so the amount, the per-turn unit and the model/token independence
    // are pinned rather than one exact phrasing of the sentence.
    expect(body).toMatch(
      /flat \*\*\$0\.10\s*\n?\s*included-service accounting value per agent turn\*\*/,
    );
    expect(body).toMatch(/independent of model choice\s*\n?\s*and token count/);
    expect(body).toMatch(/Enterprise can\s*\n?\s*use a contracted custom budget/);
    expect(body).toMatch(/bundled_flat_per_turn/);
    expect(body).not.toMatch(/Cost-per-turn varies with the underlying model/);
  });

  it('soft-cap 402 response shape pinned with spent_cents + cap_cents fields', () => {
    expect(body).toMatch(/HTTP\/1\.1 402 Payment Required/);
    expect(body).toMatch(/"spent_cents"/);
    expect(body).toMatch(/"cap_cents"/);
    expect(body).toMatch(/errors\.driftstack\.dev\/bundled-llm-budget-exhausted/);
  });

  it('typed error class field names pinned across 3 SDKs (snake_case Python; camelCase TS; PascalCase Go)', () => {
    expect(body).toMatch(/Python:[\s\S]*?`spent_cents`/);
    expect(body).toMatch(/TS:[\s\S]*?`spentCents`/);
    expect(body).toMatch(/Go:[\s\S]*?`SpentCents`/);
  });

  it('consent-required 402 response shape pinned (no extension fields)', () => {
    expect(body).toMatch(/errors\.driftstack\.dev\/bundled-llm-consent-required/);
    expect(body).toMatch(/BundledLlmConsentRequiredError/);
  });

  it('error table covers 400 / 401 / 402 (both); 503 is documented as agent-session-turn-only (not on these read routes)', () => {
    expect(body).toMatch(/\|\s*400\s*\| validation-failed/);
    expect(body).toMatch(/\|\s*401\s*\| unauthorized/);
    expect(body).toMatch(/\|\s*402\s*\| bundled-llm-budget-exhausted/);
    expect(body).toMatch(/\|\s*402\s*\| bundled-llm-consent-required/);
    // 503 was moved OUT of the settings/status error table — it surfaces on the
    // agent-session turn route only. Pin the corrected prose, ban the old table row.
    expect(body).toMatch(
      /The settings \+ status routes above do not return a `503`\. A `503`\s*\n?for an unwired bundled-LLM service is returned on the \*\*agent-session\s*\n?turn\*\* route, not on these reads\./,
    );
    expect(body).not.toMatch(/\|\s*503\s*\| feature-unavailable/);
  });

  it('privacy section documents the no-training claim against the current bundled-LLM provider (Anthropic Claude)', () => {
    expect(body).toMatch(/not used for training/);
    expect(body).toMatch(/Anthropic Claude/);
  });
});
