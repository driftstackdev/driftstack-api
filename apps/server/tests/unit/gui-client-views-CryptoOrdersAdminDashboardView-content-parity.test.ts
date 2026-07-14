// W480.B — drift guard for apps/gui-client/src/views/CryptoOrdersAdminDashboardView.tsx.
// V-534.AJ combined admin dashboard + V-534.BA idempotency
// metrics strip + V-534.BB replay-share colour coding +
// V-534.BH API spec footer. Drift here either drops the replay-
// share 3-tone thresholds (5%/20% admin signal disappears — ops
// can't tell at a glance whether the checkout double-click rate
// is normal background retry or 'something is wrong') or breaks
// the W212 docs URL fix (a Tauri WebView resolves `/docs` to
// tauri://localhost/docs and 404s instead of opening the live
// API spec on the configured API host).
//
//   • V-534.AJ/.BA/.BB/.BH quad-framing pinned.
//   • Replay-share thresholds pinned: <5%→neutral 'normal
//     background retry rate', 5-20%→warning 'worth a look',
//     >20%→alert 'something is wrong'.
//   • IdempotencyMetricsStrip subcomponent: 4-state branch
//     (loading|idle → 'Loading idempotency metrics…' + error →
//     inline 'Idempotency metrics unavailable: ${message}' +
//     ready → 4-col grid) with data-replay-tone attribute + per-
//     tone shareClass + body_mismatches ?? 0 fallback + warning
//     tint when > 0.
//   • W212 docs URL fix framing pinned: 'API spec lives on the
//     configured API host (Scalar UI at `${baseUrl}/docs/`), NOT
//     on the Tauri app's own origin.' + SettingsContext fallback
//     to DEFAULT_SETTINGS for unmounted tests.
//   • Dashboard composition: CryptoOrdersStatsCard +
//     IdempotencyMetricsStrip + 2-column grid with
//     CryptoOrdersAdminView + CryptoOrdersDailyBreakdownView +
//     footer 'View API spec' link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoOrdersAdminDashboardView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W480.B apps/gui-client/src/views/CryptoOrdersAdminDashboardView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AJ framing pinned: 'V-534.AJ — combined admin dashboard view.' + 'Stitches together the V-534.AI stats card + V-534.AG admin orders list + V-534.AH daily-breakdown table into one page. Pure layout composition; each child view handles its own fetch lifecycle.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AJ — combined admin dashboard view\./);
    expect(body).toMatch(
      /\/\/ Stitches together the V-534\.AI stats card \+ V-534\.AG admin orders\s*\n?\s*\/\/ list \+ V-534\.AH daily-breakdown table into one page\. Pure layout\s*\n?\s*\/\/ composition; each child view handles its own fetch lifecycle\./,
    );
  });

  it("V-534.BA + V-534.BB + V-534.BH framing pinned: BA 'adds a small idempotency-metrics strip alongside the stats card. The numbers come from the V-666.AP route and answer \"how often is the checkout button being double-clicked / retried\" without forcing the admin to grep logs.' + BB 'colour-codes the replay-share + surfaces the V-666.AR body-mismatch count when non-zero. Replay share thresholds: <5%→neutral, 5-20%→warning, >20%→alert.' + BH 'small footer link to the live API spec (V-666.AY / V-666.AZ). Convenience for ops integrators reading codegen.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.BA — adds a small idempotency-metrics strip alongside the\s*\n?\s*\/\/ stats card\. The numbers come from the V-666\.AP route and answer\s*\n?\s*\/\/ "how often is the checkout button being double-clicked \/ retried"\s*\n?\s*\/\/ without forcing the admin to grep logs\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BB — colour-codes the replay-share \+ surfaces the V-666\.AR\s*\n?\s*\/\/ body-mismatch count when non-zero\. Replay share thresholds:\s*\n?\s*\/\/\s+<5%\s+neutral\s+\("normal background retry rate"\)\s*\n?\s*\/\/\s+5-20% warning\s+\("worth a look"\)\s*\n?\s*\/\/\s+>20%\s+alert\s+\("something is wrong"\)/,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BH — small footer link to the live API spec \(V-666\.AY \/\s*\n?\s*\/\/ V-666\.AZ\)\. Convenience for ops integrators reading codegen\./,
    );
  });

  it('IdempotencyMetricsStrip subcomponent: total = first_writes + replays + replayShare = total===0 ? 0 : Math.round((replays/total)*100); 3-tone ternary (>20→alert, >=5→warning, else neutral) pinned for the V-666.AR admin signal', () => {
    expect(body).toMatch(
      /const total = state\.data\.first_writes \+ state\.data\.replays;\s*\n?\s*const replayShare = total === 0 \? 0 : Math\.round\(\(state\.data\.replays \/ total\) \* 100\);\s*\n?\s*const shareTone: 'neutral' \| 'warning' \| 'alert' =\s*\n?\s*replayShare > 20 \? 'alert' : replayShare >= 5 \? 'warning' : 'neutral';/,
    );
  });

  it("Per-tone shareClass + body_mismatches ?? 0 fallback + body_mismatches > 0 → text-status-warning tint; 4-col grid with role='status' + aria-label='Idempotency metrics' + data-replay-tone={shareTone} attribute for test introspection", () => {
    expect(body).toMatch(
      /const shareClass =\s*\n?\s*shareTone === 'alert'\s*\n?\s*\? 'text-status-error'\s*\n?\s*: shareTone === 'warning'\s*\n?\s*\? 'text-status-warning'\s*\n?\s*: 'text-ink-primary';/,
    );
    expect(body).toMatch(/const bodyMismatches = state\.data\.body_mismatches \?\? 0;/);
    expect(body).toMatch(
      /role="status"\s*\n?\s*aria-label="Idempotency metrics"\s*\n?\s*data-replay-tone=\{shareTone\}/,
    );
    expect(body).toMatch(
      /className=\{`font-mono \$\{bodyMismatches > 0 \? 'text-status-warning' : 'text-ink-primary'\}`\}/,
    );
  });

  it("W212 docs URL fix framing pinned: 'the API spec lives on the configured API host (Scalar UI at `${baseUrl}/docs/`), NOT on the Tauri app's own origin. `href=\"/docs\"` from a Tauri WebView resolves to tauri://localhost/docs (404). Pull baseUrl from SettingsContext when available; fall back to the DEFAULT_SETTINGS baseUrl when the context is unmounted (tests render this component in isolation without <SettingsProvider>).'", () => {
    expect(body).toMatch(
      /\/\/ W212 — the API spec lives on the configured API host \(Scalar UI\s*\n?\s*\/\/ at `\$\{baseUrl\}\/docs\/`\), NOT on the Tauri app's own origin\.\s*\n?\s*\/\/ `href="\/docs"` from a Tauri WebView resolves to tauri:\/\/localhost\/docs\s*\n?\s*\/\/ \(404\)\. Pull baseUrl from SettingsContext when available; fall\s*\n?\s*\/\/ back to the DEFAULT_SETTINGS baseUrl when the context is\s*\n?\s*\/\/ unmounted \(tests render this component in isolation without\s*\n?\s*\/\/ <SettingsProvider>\)\./,
    );
    expect(body).toMatch(
      /const ctx = useContext\(SettingsContext\);\s*\n?\s*const baseUrl = ctx\?\.settings\.baseUrl \?\? DEFAULT_SETTINGS\.baseUrl;\s*\n?\s*const docsUrl = `\$\{baseUrl\.replace\(\/\\\/\+\$\/, ''\)\}\/docs\/`;/,
    );
  });

  it("Dashboard composition: 'Crypto orders — admin dashboard' h1 + subline + <CryptoOrdersStatsCard /> + <IdempotencyMetricsStrip /> + 2-column xl:grid with section aria-label='Orders list' wrapping <CryptoOrdersAdminView /> + section aria-label='Daily breakdown' wrapping <CryptoOrdersDailyBreakdownView />; footer 'View API spec' link with target='_blank' rel='noreferrer' + 'admin + customer crypto endpoints documented at /openapi.json' note", () => {
    expect(body).toMatch(
      /<h1 className="text-xl font-semibold">Crypto orders — admin dashboard<\/h1>\s*\n?\s*<p className="text-sm text-ink-secondary">\s*\n?\s*At-a-glance summary, full order list with filters, and a daily breakdown\.\s*\n?\s*<\/p>/,
    );
    expect(body).toMatch(
      /<CryptoOrdersStatsCard \/>\s*\n?\s*<IdempotencyMetricsStrip \/>\s*\n?\s*<div className="grid grid-cols-1 gap-6 xl:grid-cols-2">\s*\n?\s*<section aria-label="Orders list" className="min-w-0">\s*\n?\s*<CryptoOrdersAdminView \/>\s*\n?\s*<\/section>\s*\n?\s*<section aria-label="Daily breakdown" className="min-w-0">\s*\n?\s*<CryptoOrdersDailyBreakdownView \/>\s*\n?\s*<\/section>\s*\n?\s*<\/div>/,
    );
    expect(body).toMatch(
      /<a\s*\n?\s*href=\{docsUrl\}\s*\n?\s*target="_blank"\s*\n?\s*rel="noreferrer"\s*\n?\s*className="underline hover:text-ink-primary"\s*\n?\s*>\s*\n?\s*View API spec\s*\n?\s*<\/a>\{' '\}\s*\n?\s*&middot; admin \+ customer crypto endpoints documented at <code>\/openapi\.json<\/code>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
