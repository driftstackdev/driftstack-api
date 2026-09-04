// W264.C — drift-guard for /docs/sla-policy. Pins every tier id
// cited in the page to a real AccountTierSchema enum value.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sla-policy.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W264.C /docs/sla-policy ↔ AccountTierSchema parity', () => {
  const page = read(PAGE);
  const liveTiers = new Set(AccountTierSchema.options);

  it('every tier id in the SLA table is a real AccountTierSchema value', () => {
    const cited = [
      ...page.matchAll(
        /<code>(trial_pack|solo_manual|team_manual|agency_manual|api_starter|api_builder|api_scale|enterprise)<\/code>/g,
      ),
    ].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(5);
    const offenders = cited.filter((t) => !liveTiers.has(t as never));
    expect(offenders).toEqual([]);
  });

  it('every live tier appears in the SLA copy at least once', () => {
    for (const t of liveTiers) {
      expect(page).toMatch(new RegExp(`<code>${t}</code>`));
    }
  });

  it('SLA endpoints covered match the live customer-facing surface', () => {
    expect(page).toMatch(/https:\/\/api\.driftstack\.dev\/\*/);
    expect(page).toMatch(/https:\/\/app\.driftstack\.io\/\*/);
  });

  it('cites /health as the probe target (alias /healthz; no /v1 prefix)', () => {
    // The server registers `/health` + `/healthz` (apps/server/src/lib/app.ts)
    // with no /v1 prefix — the doc's GET /health is correct.
    expect(page).toMatch(/GET \/health/);
    expect(page).toMatch(/\/healthz/);
    expect(page).not.toMatch(/GET \/v1\/health/);
  });

  it('cross-links to /docs/incident-policy + /docs/api-versioning', () => {
    expect(page).toMatch(/\/docs\/incident-policy/);
    expect(page).toMatch(/\/docs\/api-versioning/);
  });

  it('does not advertise SLA targets we cannot meet (e.g. 100% for non-enterprise)', () => {
    expect(page).not.toMatch(/100%/);
  });
});
