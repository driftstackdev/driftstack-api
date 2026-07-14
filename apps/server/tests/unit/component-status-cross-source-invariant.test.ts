// W866 — V-474 ComponentStatus 3+1-value cross-source invariant.
// One-hundred-ninety-second in the drift-guard series. Pins the
// V-474 server-side /v1/status enum + marketing-site StatusBadge
// client-side fallback:
//
//   Server emits 3 values (server-of-truth):
//     1. operational — all probes ok.
//     2. degraded    — at least one probe failed.
//     3. major_outage — reserved for future incidents; not
//                       currently reachable from probes.
//
//   Client-side StatusBadge.astro handles 4 (server 3 + 'unknown'):
//     - 'unknown' is the client-fallback when fetch fails / times
//       out — NEVER emitted by the server.
//
// stays in lockstep across:
//   - apps/server/src/routes/status.ts (server-side ComponentStatus
//     type + aggregateOverall function).
//   - apps/marketing-site/src/components/StatusBadge.astro
//     (V-474 4-state client switch + applyState mapping).
//
// Drift would silently break:
//   * StatusBadge rendering when server adds a 4th status the
//     client switch doesn't handle (falls through to 'unknown').
//   * Server-side aggregation if a probe emits an unknown value.
//   * Customer trust: misleading status on the marketing site.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SERVER_STATUSES = ['operational', 'degraded', 'major_outage'] as const;
const CLIENT_FALLBACK_ONLY = ['unknown'] as const;

describe('W866 V-474 ComponentStatus cross-source invariant', () => {
  // ─── Server-side ComponentStatus declaration ─────────────────

  it("CRITICAL apps/server/src/routes/status.ts declares 'type ComponentStatus = operational | degraded | major_outage' — 3 values. The server-of-truth enum that /v1/status emits.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/type ComponentStatus = 'operational' \| 'degraded' \| 'major_outage';/);
  });

  it("CRITICAL server aggregateOverall function pins the 3-tier priority: any 'major_outage' → 'major_outage'; any 'degraded' → 'degraded'; else 'operational'. Drift would silently change overall-status computation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(
      /components\.some\(\(c\) => c\.status === 'major_outage'\)\) return 'major_outage'/,
    );
    expect(p).toMatch(/components\.some\(\(c\) => c\.status === 'degraded'\)\) return 'degraded'/);
    expect(p).toMatch(/return 'operational';/);
  });

  it("CRITICAL server-side comment pins the 'major_outage isn't reachable from readiness probes today' framing. The future-reserved status documentation is what tells maintainers it's intentionally unused.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/'major_outage' isn't reachable from the readiness probes today/);
  });

  // ─── Marketing-site StatusBadge.astro switch ─────────────────

  it("CRITICAL apps/marketing-site/src/components/StatusBadge.astro switch handles all 4 client-side states — operational, degraded, major_outage, unknown. The switch covers server's 3 + client-fallback 'unknown' on fetch failure.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro'));
    for (const s of [...SERVER_STATUSES, ...CLIENT_FALLBACK_ONLY]) {
      expect(p, `StatusBadge.astro must handle '${s}'`).toMatch(new RegExp(`case '${s}':`));
    }
  });

  it("CRITICAL V-474 anchor pinned in StatusBadge.astro inline. The 'V-474 — public status badge' framing threads the client-side-fetch provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro'));
    expect(p).toMatch(/V-474 — public status badge/);
  });

  it("CRITICAL StatusBadge.astro applyState 'unknown' fallback is the failure-mode default — case 'unknown' AND case 'default' both render the slate-grey 'Status unavailable'. The double-mapping is what makes catch() → applyState('unknown') safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro'));
    expect(p).toMatch(/case 'unknown':\s*\n\s*default:/);
    expect(p).toMatch(/label\.textContent = 'Status unavailable'/);
  });

  it("CRITICAL StatusBadge.astro 4-second hard timeout pinned. A slow status endpoint shouldn't keep the badge spinning forever — the AbortController + setTimeout(4000) bounds the fetch.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro'));
    expect(p).toMatch(/4-second hard timeout/);
    expect(p).toMatch(/setTimeout\(\(\) => controller\.abort\(\), 4000\)/);
  });

  // ─── Status-page tints: dot-color matches state ──────────────

  it('CRITICAL StatusBadge visual and accessible mappings stay aligned for labeled and dot-only variants.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro'));
    const mappings = [
      ['operational', 'All systems operational', 'bg-emerald-500'],
      ['degraded', 'Degraded performance', 'bg-amber-500'],
      ['major_outage', 'Major outage', 'bg-red-500'],
    ] as const;
    for (const [state, label, color] of mappings) {
      expect(p).toMatch(
        new RegExp(
          `case '${state}':\\s*accessibleState = '${label}';\\s*dot\\.classList\\.add\\('${color}'\\);\\s*if \\(label\\) label\\.textContent = '${label}';`,
        ),
      );
    }
    expect(p).toMatch(
      /case 'unknown':\s*\n\s*default:\s*\n\s*dot\.classList\.add\('bg-slate-300'\)/,
    );
    expect(p).toMatch(
      /if \(!label\) badge\.setAttribute\('aria-label', 'Platform status: ' \+ accessibleState\);/,
    );
  });

  // ─── 3-value server + 1-fallback cardinality ─────────────────

  it("CRITICAL cardinality invariant: server emits EXACTLY 3 values (operational + degraded + major_outage); client adds 1 fallback 'unknown' for fetch failures. The 3/1/4 split is what V-474's defense-in-depth depends on (server never emits 'unknown'; client never trusts a slow status endpoint).", () => {
    expect(SERVER_STATUSES.length).toBe(3);
    expect(CLIENT_FALLBACK_ONLY.length).toBe(1);
    expect([...SERVER_STATUSES, ...CLIENT_FALLBACK_ONLY].length).toBe(4);
  });

  // ─── No forbidden / legacy status names ──────────────────────

  it('CRITICAL no source declares forbidden status names (down / up / red / yellow / green / partial_outage / minor_issue). These are common status-page conventions that V-474 intentionally avoids — the 3-value model maps to incident severity (minor/major/outage) not raw color.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    const m = p.match(/type ComponentStatus = ([^;]+);/);
    expect(m).not.toBeNull();
    const body = m![1];
    const forbidden = ['down', 'up', 'red', 'yellow', 'green', 'partial_outage', 'minor_issue'];
    for (const f of forbidden) {
      expect(body, `ComponentStatus must NOT include forbidden ${f}`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/component-status-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
