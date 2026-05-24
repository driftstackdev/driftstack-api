// Drift guard for apps/admin-panel/src/pages/cost.astro. Pins the V-541
// admin cost dashboard surface: V-541.B framing + V-100 internal_admin
// scope + the 3-endpoint admin/cost surface + the softCents/hardCents
// field-name contract (the off-by-naming bug that previously rendered
// every tier as $0.00) + the cost-monitoring.ts response shape anchor.
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

  it('Cost (V-541) header anchor pinned: h1 contains "Cost (V-541)". 2026-05-23 — h1 wrapped in oxblood gradient span (admin-panel visual unification); V-anchor preserved.', () => {
    expect(body).toMatch(/<h1 class="mt-1 text-3xl font-semibold tracking-tight text-slate-900">/);
    expect(body).toMatch(/Cost \(V-541\)/);
  });

  it("data-page='admin-cost' wrapper pinned (used by the inline-JS root selector). Drift to a different data-page name would silently disconnect the inline script from the DOM root and leave every tile rendering its SSG-time placeholder", () => {
    expect(body).toMatch(/data-page="admin-cost"/);
    expect(body).toMatch(/document\.querySelector\('\[data-page="admin-cost"\]'\)/);
  });

  it("3-endpoint admin/cost surface pinned: /v1/admin/cost/config + /v1/admin/cost/accounts/:id + /v1/admin/cost/overview. Drift to dropping /overview would break the 'Top accounts by cost' table; drift to dropping /config would break the soft/hard threshold display; drift to dropping /accounts/:id would break the per-account lookup form", () => {
    expect(body).toMatch(/<code class="font-mono">\{apiBaseUrl\}\/v1\/admin\/cost\/config<\/code>/);
    expect(body).toMatch(
      /<code class="font-mono">\{apiBaseUrl\}\/v1\/admin\/cost\/accounts\/:id<\/code>/,
    );
    expect(body).toMatch(
      /<code class="font-mono">\{apiBaseUrl\}\/v1\/admin\/cost\/overview<\/code>/,
    );
  });

  it('AlertThresholds field-name contract: softCents + hardCents (lib/cost-estimator.ts naming). Drift to softWarningCents/hardCapCents would silently render every tier as $0.00 — the exact regression call-out that the in-code comment defends against. Load-bearing parity test (this is the bug the file-level comment specifically names)', () => {
    expect(body).toMatch(
      /\/\/ GET \/v1\/admin\/cost\/config returns ``softCents, hardCents``|\/\/ GET \/v1\/admin\/cost\/config returns `\{ softCents, hardCents \}`/,
    );
    expect(body).toMatch(
      /\/\/ per AlertThresholds in lib\/cost-estimator\.ts\. Reading\s*\n?\s*\/\/ `softWarningCents` \/ `hardCapCents` \(a previous field-name\s*\n?\s*\/\/ guess\) silently rendered every tier as "\$0\.00"\./,
    );
    expect(body).toMatch(/\(t\.softCents \?\? 0\) \/ 100/);
    expect(body).toMatch(/\(t\.hardCents \?\? 0\) \/ 100/);
  });

  it("CostMonitoringAccountSummary shape framing pinned: 'GET /v1/admin/cost/accounts/:id returns CostMonitoringAccountSummary (cost-monitoring.ts): { account_id, billing_cycle, breakdown: CostBreakdown, tier, thresholds: { softCents, hardCents } }'. Drift to a different shape would silently break the per-account render (the field-references in renderAccountSummary depend on this exact projection)", () => {
    expect(body).toMatch(
      /\/\/ GET \/v1\/admin\/cost\/accounts\/:id returns CostMonitoringAccountSummary\s*\n?\s*\/\/ \(cost-monitoring\.ts\):\s*\n?\s*\/\/ {3}\{ account_id, billing_cycle, breakdown: CostBreakdown,\s*\n?\s*\/\/ {5}tier, thresholds: \{ softCents, hardCents \} \}/,
    );
  });

  it("'Top accounts by cost' framing pinned: 'Sorted descending by total cents in the current cycle. Fetches the first limit=50 accounts then asks /v1/admin/cost/overview (which already returns sorted by total cost desc).' — pinned so the server-already-sorts-desc contract + the 50-row pagination cap survive (drift to client-side resort would silently mismatch server's ranking; drift to dropping limit=50 would let operators trigger 10k-row dumps on accounts with many billing accounts)", () => {
    expect(body).toMatch(
      /Sorted descending by total cents in the current cycle\. Fetches the\s*\n?\s*first <code class="font-mono text-xs">limit=50<\/code> accounts then\s*\n?\s*asks <code class="font-mono text-xs">\/v1\/admin\/cost\/overview<\/code>\s*\n?\s*\(which already returns sorted by total cost desc\)\./,
    );
  });

  it("Cents-to-dollar helper inline pattern pinned: 'const cents = (n) => $ + (Number(n ?? 0) / 100).toFixed(2);'. Drift to dropping ?? 0 fallback would render NaN for null entries; drift to a different precision would break consistency with the rest of the admin panel's currency display", () => {
    expect(body).toMatch(
      /const cents = \(n\) => '\$' \+ \(Number\(n \?\? 0\) \/ 100\)\.toFixed\(2\);/,
    );
  });
});
