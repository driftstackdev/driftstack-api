// W481.C — drift guard for apps/gui-client/src/views/ConnectivityView.tsx.
// Connectivity test view. Drift here either drops the V-337
// server-version surface ('you're talking to a mock server'
// mismatch becomes invisible — founder thinks they're calling
// prod when they're hitting a mock) or breaks the cancelled-
// flag effect cleanup (a fast unmount during the /version
// fetch sets state on an unmounted component and React logs
// the dev warning).
//
//   • Framing pinned: 'Connectivity test — verifies the
//     configured API key + base URL by making a real call
//     against the server.' + delegation framing 'Hits
//     `client.sessions.list({ limit: 1 })` rather than a
//     dedicated /healthz route — every authenticated endpoint
//     exercises the same auth + rate-limit + DB chain, and
//     `list` is the cheapest one.'
//   • V-337 framing pinned: 'surface the server's driver mode
//     + version when we can reach the public /version endpoint.
//     Helps the founder spot "you're talking to a mock server"
//     mismatches without running /version manually.'
//   • CheckResult 4-field (ok + durationMs + detail +
//     errorKind?); ServerVersion 4-field with driver 3-value
//     union ('mock' | 'webkit' | 'playwright') + optional
//     playwright_browser 3-value union ('webkit' | 'chromium'
//     | 'firefox').
//   • /version effect: cancelled flag + trim trailing-slash +
//     setServerInfo only when !cancelled && info.
//   • runCheck: performance.now() ms timing + client.sessions.
//     list({limit:1}) + DriftstackError instanceof for
//     errorKind extraction.
//   • API-key masking: settings.apiKey.slice(0,8) +
//     '…' (U+2026) + slice(-4).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/ConnectivityView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W481.C apps/gui-client/src/views/ConnectivityView.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'Connectivity test — verifies the configured API key + base URL by making a real call against the server. Useful when something stops working: is the key wrong? is the server down? is the network down?' + delegation framing 'Hits `client.sessions.list({ limit: 1 })` rather than a dedicated /healthz route — every authenticated endpoint exercises the same auth + rate-limit + DB chain, and `list` is the cheapest one.'", () => {
    expect(body).toMatch(
      /\/\/ Connectivity test — verifies the configured API key \+ base URL by\s*\n?\s*\/\/ making a real call against the server\. Useful when something stops\s*\n?\s*\/\/ working: is the key wrong\? is the server down\? is the network down\?/,
    );
    expect(body).toMatch(
      /\/\/ Hits `client\.sessions\.list\(\{ limit: 1 \}\)` rather than a dedicated\s*\n?\s*\/\/ \/healthz route — every authenticated endpoint exercises the same\s*\n?\s*\/\/ auth \+ rate-limit \+ DB chain, and `list` is the cheapest one\./,
    );
  });

  it("V-337 framing pinned: 'surface the server's driver mode + version when we can reach the public /version endpoint. Helps the founder spot \"you're talking to a mock server\" mismatches without running /version manually.'", () => {
    expect(body).toMatch(
      /\/\/ V-337 — surface the server's driver mode \+ version when we can\s*\n?\s*\/\/ reach the public \/version endpoint\. Helps the founder spot\s*\n?\s*\/\/ "you're talking to a mock server" mismatches without running\s*\n?\s*\/\/ \/version manually\./,
    );
  });

  it("CheckResult 4-field (ok: boolean + durationMs: number + detail: string + errorKind? optional) + ServerVersion 4-field with driver 3-value union ('mock' | 'webkit' | 'playwright') + playwright_browser? 3-value union ('webkit' | 'chromium' | 'firefox') — pinned so the V-337 driver/browser surface tracks the server-side enum", () => {
    expect(body).toMatch(
      /interface CheckResult \{\s*\n?\s*ok: boolean;\s*\n?\s*durationMs: number;\s*\n?\s*detail: string;\s*\n?\s*errorKind\?: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /interface ServerVersion \{\s*\n?\s*version: string;\s*\n?\s*git_sha: string;\s*\n?\s*driver: 'mock' \| 'webkit' \| 'playwright';\s*\n?\s*playwright_browser\?: 'webkit' \| 'chromium' \| 'firefox';\s*\n?\s*\}/,
    );
  });

  it('/version fetch effect is bounded, cache-fresh, and aborts on URL change/unmount', () => {
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(/window\.setTimeout\(\(\) => controller\.abort\(\), 8_000\)/);
    expect(body).toMatch(
      /fetch\(`\$\{trimmed\}\/version`, \{ signal: controller\.signal, cache: 'no-store' \}\)/,
    );
    expect(body).toMatch(/\.finally\(\(\) => \{\s*window\.clearTimeout\(timer\);/);
    expect(body).toMatch(
      /return \(\) => \{\s*cancelled = true;\s*window\.clearTimeout\(timer\);\s*controller\.abort\(\);/,
    );
    expect(body).toMatch(/if \(!cancelled && info\) setServerInfo\(info\)/);
  });

  it("runCheck: performance.now() ms timing (start → end → Math.round) + client.sessions.list({limit: 1}) delegation + 'API replied with N session(s) on the first page.' detail format + DriftstackError instanceof for errorKind extraction + 'unknown error' / 'unknown' kind fallbacks", () => {
    expect(body).toMatch(
      /const start = performance\.now\(\);\s*\n?\s*try \{\s*\n?\s*const page = await client\.sessions\.list\(\{ limit: 1 \}\);\s*\n?\s*const durationMs = Math\.round\(performance\.now\(\) - start\);\s*\n?\s*setResult\(\{\s*\n?\s*ok: true,\s*\n?\s*durationMs,\s*\n?\s*detail: `API replied with \$\{page\.data\.length\} session\$\{page\.data\.length === 1 \? '' : 's'\} on the first page\.`,\s*\n?\s*\}\);\s*\n?\s*\} catch \(err\) \{\s*\n?\s*const durationMs = Math\.round\(performance\.now\(\) - start\);\s*\n?\s*const detail = err instanceof Error \? err\.message : 'unknown error';\s*\n?\s*const errorKind = err instanceof DriftstackError \? err\.kind : 'unknown';/,
    );
  });

  it("API-key masking + 'not set' fallback: settings.apiKey === null → 'not set — configure under Settings' in text-status-error else maskApiKey(settings.apiKey) — the shared, prefix-aware mask (consistency standardization, replacing the old non-standard inline slice(0,8)…slice(-4)); apiKey unmasked has 'configure under Settings' nudge so user knows where to set it", () => {
    expect(body).toMatch(
      /\{settings\.apiKey === null \? \(\s*\n?\s*<span className="text-status-error">not set — configure under Settings<\/span>\s*\n?\s*\) : \([\s\S]*?maskApiKey\(settings\.apiKey\)\s*\n?\s*\)\}/,
    );
  });
  it('imports the shared maskApiKey from ApiKeyMaskedSpan (prefix-aware mask used everywhere a key is shown)', () => {
    expect(body).toMatch(/import \{ maskApiKey \} from '\.\.\/components\/ApiKeyMaskedSpan';/);
  });

  it("V-337 server-info rows: driver row 'playwright (chromium)' format when driver===playwright && playwright_browser truthy + version row 'X.Y.Z · gitsha7' format when git_sha !== 'unknown' (.slice(0,7) short-sha); both rows only render when serverInfo !== null", () => {
    expect(body).toMatch(
      /\{serverInfo !== null && \(\s*\n?\s*<>\s*\n?\s*<Row label="Server driver">/,
    );
    expect(body).toMatch(
      /\{serverInfo\.driver\}\s*\n?\s*\{serverInfo\.driver === 'playwright' && serverInfo\.playwright_browser\s*\n?\s*\? ` \(\$\{serverInfo\.playwright_browser\}\)`\s*\n?\s*: ''\}/,
    );
    expect(body).toMatch(
      /\{serverInfo\.version\}\s*\n?\s*\{serverInfo\.git_sha !== 'unknown' \? ` · \$\{serverInfo\.git_sha\.slice\(0, 7\)\}` : ''\}/,
    );
  });

  it("ResultBlock: ok branch → status-ready tints + 'OK' section-label + durationMs ms display; fail branch → status-error tints + 'Failed' + errorKind '· {kind}' suffix conditional on errorKind !== undefined; both render Row helper Component with section-label + grid-cols-[10rem_1fr] layout", () => {
    expect(body).toMatch(
      /function Row\(\{ label, children \}: \{ label: string; children: React\.ReactNode \}\): JSX\.Element \{\s*\n?\s*return \(\s*\n?\s*<div className="grid grid-cols-\[10rem_1fr\] items-center gap-3 text-sm">\s*\n?\s*<span className="section-label">\{label\}<\/span>/,
    );
    expect(body).toMatch(
      /if \(result\.ok\) \{\s*\n?\s*return \(\s*\n?\s*<div className="rounded-xl border border-status-ready\/30 bg-status-ready\/10 px-4 py-3">/,
    );
    expect(body).toMatch(
      /\{result\.errorKind !== undefined && \(\s*\n?\s*<span className="mono text-2xs text-ink-muted">· \{result\.errorKind\}<\/span>\s*\n?\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
