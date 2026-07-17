// Drift guard for apps/admin-panel/src/pages/cost.astro. Pins the V-541
// admin cost dashboard surface: V-541.B framing + V-100 internal_admin
// scope + the 3-endpoint admin/cost surface + strict wire decoding and
// compute-only measurement truth. Malformed 200s must never become a
// plausible zero-cost dashboard or CSV.
//
// Complements the lighter admin-panel-pages-cost-field-name-parity test
// which only pins the field-name bug. This file pins the load-bearing
// framing pieces around it.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/cost.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('admin-panel pages/cost content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-541.B framing pinned: 'admin cost dashboard. Static shell + progressive-enhanced inline JS that fetches /v1/admin/cost/config (rate card + tier thresholds, no usage data) on load, then lets the operator query /v1/admin/cost/accounts/:id for a per-account breakdown.' — pinned so the static-shell + 2-fetch pattern + the explicit no-usage-data-in-config caveat all stay documented (drift to merging config + usage into one fetch would couple shape changes; drift to a different anchor would orphan the V-541.B provenance)", () => {
    expect(body).toMatch(
      /\/\/ V-541\.B — admin cost dashboard\. Static shell \+ progressive-enhanced\s*\n?\s*\/\/ inline JS that fetches \/v1\/admin\/cost\/config \(rate card \+ tier\s*\n?\s*\/\/ thresholds, no usage data\) on load, then lets the operator query\s*\n?\s*\/\/ \/v1\/admin\/cost\/accounts\/:id for a per-account breakdown\./,
    );
  });

  it("V-100 internal_admin scope framing pinned: 'tile values come from the same admin token the rest of the admin panel uses (V-100 internal_admin scope). 401/403 surfaces a banner, not silent failure.' — pinned so the V-100-scope-reference + the explicit 401/403-banner contract stays documented (drift to silent failure would leave operators staring at $0.00 with no signal that auth failed)", () => {
    expect(body).toMatch(
      /\/\/ Pre-launch posture: tile values come from the same admin token the\s*\n?\s*\/\/ rest of the admin panel uses \(V-100 internal_admin scope\)\. 401\/403\s*\n?\s*\/\/ surfaces a banner, not silent failure\./,
    );
  });

  it('Cost header pinned to the clean operator-facing "Cost" h1 — the internal "(V-541)" workstream code is NOT leaked into customer/operator-facing copy (drift to re-adding "(V-541)" would re-expose internal sweep codes on the page operators see)', () => {
    expect(body).toMatch(
      /<h1 class="mt-1 text-3xl font-semibold tracking-tight text-tk-ink">Cost<\/h1>/,
    );
    // The internal workstream anchor must NOT appear in the rendered H1 copy.
    expect(body).not.toMatch(/Cost \(V-541\)/);
  });

  it("data-page='admin-cost' wrapper pinned (used by the inline-JS root selector). Drift to a different data-page name would silently disconnect the inline script from the DOM root and leave every tile rendering its SSG-time placeholder", () => {
    expect(body).toMatch(/data-page="admin-cost"/);
    expect(body).toMatch(/document\.querySelector\('\[data-page="admin-cost"\]'\)/);
  });

  it('3-endpoint admin/cost surface is pinned', () => {
    expect(body).toMatch(/<code class="font-mono">\{apiBaseUrl\}\/v1\/admin\/cost\/config<\/code>/);
    expect(body).toMatch(
      /<code class="font-mono">\{apiBaseUrl\}\/v1\/admin\/cost\/accounts\/:id<\/code>/,
    );
    expect(body).toMatch(
      /<code class="font-mono">\{apiBaseUrl\}\/v1\/admin\/cost\/overview<\/code>/,
    );
  });

  it('presents the current surface as a compute-only accounting estimate with explicit unmeasured dimensions', () => {
    expect(body).toContain('Compute-only operational estimate for the current UTC billing cycle.');
    expect(body).toContain('Storage, egress,');
    expect(body).toContain('values are placeholders and must not be read as zero actual cost.');
    expect(body).toContain('Measured total · compute only');
    expect(body).toContain('Unmeasured');
    expect(body).toContain("return (cents / 100).toFixed(2) + ' accounting units';");
    expect(body).not.toMatch(/const cents =|\$\{?\(?\(?(?:breakdown|thresholds|t)\./);
  });

  it('strictly decodes config, account summaries, account pages, and overview payloads before rendering', () => {
    expect(body).toContain('function parseConfigPayload(value)');
    expect(body).toContain('function parseCostSummary(value, expectedAccountId, expectedCycle)');
    expect(body).toContain('function parseAccountsPage(value)');
    expect(body).toContain('function parseOverviewPayload(value, requestedIds, expectedCycle)');
    expect(body).toContain('const config = parseConfigPayload(body);');
    expect(body).toContain(
      'renderAccountSummary(parseCostSummary(body, accountId, billingCycle));',
    );
    expect(body).toContain('const ids = parseAccountsPage(accountsBody);');
    expect(body).toContain(
      'renderTopAccounts(parseOverviewPayload(overviewBody, ids, overviewCycle));',
    );
    expect(body).toContain("throw new Error('invalid cost response');");
  });

  it('binds summaries to requested identity/cycle and validates totals, thresholds, and compute-only placeholders', () => {
    expect(body).toContain('value.account_id !== expectedAccountId');
    expect(body).toContain('value.billing_cycle !== expectedCycle');
    expect(body).toContain('value.totalCents !== componentTotal');
    expect(body).toContain('value.storageCents !== 0');
    expect(body).toContain('value.emailCents !== 0');
    expect(body).toContain('value.thresholdState !== expectedState');
    expect(body).toContain('value.hardCents <= value.softCents');
  });

  it('keeps the newest-50 scope honest and validates list/overview identity, uniqueness, cursor, and ordering', () => {
    expect(body).toContain('Highest compute estimates among newest 50 accounts');
    expect(body).toContain('not the platform-wide highest-cost accounts');
    expect(body).toContain('Accounts outside that page are not');
    expect(body).toContain("authedFetch('/v1/admin/accounts?limit=50')");
    expect(body).toContain('seen.has(id)');
    expect(body).toContain('row.created_at > priorCreatedAt');
    expect(body).toContain('value.next_cursor !== `acc_${ids[ids.length - 1]}`');
    expect(body).toContain('!requested.has(accountId)');
    expect(body).toContain('seen.has(accountId)');
    expect(body).toContain('summary.breakdown.totalCents > priorTotal');
  });

  it('clears stale global errors on a new operation and only grants CSV after a valid current table', () => {
    expect(body).toContain('function clearBanner()');
    expect(body).toMatch(/async function loadTopAccounts\(\)[\s\S]*?clearBanner\(\);/);
    expect(body).toMatch(
      /renderAccountSummary\(parseCostSummary\(body, accountId, billingCycle\)\);\s*clearBanner\(\);/,
    );
    expect(body).toContain('topAccountsAvailable = true;');
    expect(body).toContain('if (!topAccountsAvailable) return;');
  });

  it('read controls and programmatic handlers require live cost authority, while CSV additionally requires a successful current top table', () => {
    expect(body).toMatch(
      /name="account_id"\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"\s*\n?\s*title="Available after live cost configuration loads\."/,
    );
    expect(body).toMatch(
      /data-button="export-top-csv"\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/,
    );
    expect(body).toContain('let costDataAvailable = false;');
    expect(body).toContain('let topAccountsAvailable = false;');
    expect(body).toContain('if (!costDataAvailable || !topResult || topAccountsLoading) return;');
    expect(body).toContain('if (!costDataAvailable || accountQueryLoading) return;');
    expect(body).toContain('if (!topAccountsAvailable) return;');
    expect(body).toMatch(
      /loadConfig\(\)\s*\n?\s*\.then\(\(loaded\) => \{\s*\n?\s*setCostDataAuthority\(loaded, 'Available after live cost configuration loads\.'\);/,
    );
  });
});
