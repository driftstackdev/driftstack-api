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

// Keep this check at module load, before any content regex executes. A stale
// assertion once combined these three fragments directly; because `\s` also
// consumes newlines, V8 backtracked for minutes and Vitest could not service
// its timeout. Constructing the marker avoids embedding the forbidden token in
// this guard itself.
const AMBIGUOUS_MULTILINE_SEPARATOR = String.raw`\s*` + String.raw`\n?` + String.raw`\s*`;
if (read(fileURLToPath(import.meta.url)).includes(AMBIGUOUS_MULTILINE_SEPARATOR)) {
  throw new Error('ConnectivityView content guard contains an ambiguous multiline separator');
}

describe('W481.C apps/gui-client/src/views/ConnectivityView.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'Connectivity test — verifies the configured API key + base URL by making a real call against the server. Useful when something stops working: is the key wrong? is the server down? is the network down?' + delegation framing 'Hits `client.sessions.list({ limit: 1 })` rather than a dedicated /healthz route — every authenticated endpoint exercises the same auth + rate-limit + DB chain, and `list` is the cheapest one.'", () => {
    expect(body).toMatch(
      /\/\/ Connectivity test — verifies the configured API key \+ base URL by[ \t]*(?:\r?\n[ \t]*)?\/\/ making a real call against the server\. Useful when something stops[ \t]*(?:\r?\n[ \t]*)?\/\/ working: is the key wrong\? is the server down\? is the network down\?/,
    );
    expect(body).toMatch(
      /\/\/ Hits `client\.sessions\.list\(\{ limit: 1 \}\)` rather than a dedicated[ \t]*(?:\r?\n[ \t]*)?\/\/ \/healthz route — every authenticated endpoint exercises the same[ \t]*(?:\r?\n[ \t]*)?\/\/ auth \+ rate-limit \+ DB chain, and `list` is the cheapest one\./,
    );
  });

  it("V-337 framing pinned: 'surface the server's driver mode + version when we can reach the public /version endpoint. Helps the founder spot \"you're talking to a mock server\" mismatches without running /version manually.'", () => {
    expect(body).toMatch(
      /\/\/ V-337 — surface the server's driver mode \+ version when we can[ \t]*(?:\r?\n[ \t]*)?\/\/ reach the public \/version endpoint\. Helps the founder spot[ \t]*(?:\r?\n[ \t]*)?\/\/ "you're talking to a mock server" mismatches without running[ \t]*(?:\r?\n[ \t]*)?\/\/ \/version manually\./,
    );
  });

  it("CheckResult 4-field (ok: boolean + durationMs: number + detail: string + errorKind? optional) + ServerVersion 4-field with driver 3-value union ('mock' | 'webkit' | 'playwright') + playwright_browser? 3-value union ('webkit' | 'chromium' | 'firefox') — pinned so the V-337 driver/browser surface tracks the server-side enum", () => {
    expect(body).toMatch(
      /interface CheckResult \{[ \t]*(?:\r?\n[ \t]*)?ok: boolean;[ \t]*(?:\r?\n[ \t]*)?durationMs: number;[ \t]*(?:\r?\n[ \t]*)?detail: string;[ \t]*(?:\r?\n[ \t]*)?errorKind\?: string;[ \t]*(?:\r?\n[ \t]*)?\}/,
    );
    expect(body).toMatch(
      /interface ServerVersion \{[ \t]*(?:\r?\n[ \t]*)?version: string;[ \t]*(?:\r?\n[ \t]*)?git_sha: string;[ \t]*(?:\r?\n[ \t]*)?driver: 'mock' \| 'webkit' \| 'playwright';[ \t]*(?:\r?\n[ \t]*)?playwright_browser\?: 'webkit' \| 'chromium' \| 'firefox';[ \t]*(?:\r?\n[ \t]*)?\}/,
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

  it('runCheck keeps timing/list delegation, fixed success copy, shared safe error copy, stable kind classification, and the running latch', () => {
    expect(body).toContain("import { humanizeError } from '../lib/humanize-error';");
    expect(body).toContain('const start = performance.now();');
    expect(body).toContain('const page = await client.sessions.list({ limit: 1 });');
    expect(body).toContain('const durationMs = Math.round(performance.now() - start);');
    expect(body).toContain(
      "detail: `API replied with ${page.data.length} session${page.data.length === 1 ? '' : 's'} on the first page.`,",
    );
    expect(body).toContain(
      "'Connectivity check failed. Verify the API URL and key in Settings, then try again.',",
    );
    expect(body).toContain(
      "const errorKind = err instanceof DriftstackError ? err.kind : 'unknown';",
    );
    expect(body).toContain('setResult({ ok: false, durationMs, detail, errorKind });');
    expect(body).toContain('finally {\n      setRunning(false);');
    expect(body).not.toContain("err instanceof Error ? err.message : 'unknown error'");
  });

  it("API-key masking + 'not set' fallback: settings.apiKey === null → 'not set — configure under Settings' in text-status-error else maskApiKey(settings.apiKey) — the shared, prefix-aware mask (consistency standardization, replacing the old non-standard inline slice(0,8)…slice(-4)); apiKey unmasked has 'configure under Settings' nudge so user knows where to set it", () => {
    expect(body).toMatch(
      /\{settings\.apiKey === null \? \([ \t]*(?:\r?\n[ \t]*)?<span className="text-status-error">not set — configure under Settings<\/span>[ \t]*(?:\r?\n[ \t]*)?\) : \([\s\S]*?maskApiKey\(settings\.apiKey\)[ \t]*(?:\r?\n[ \t]*)?\)\}/,
    );
  });
  it('imports the shared maskApiKey from ApiKeyMaskedSpan (prefix-aware mask used everywhere a key is shown)', () => {
    expect(body).toMatch(/import \{ maskApiKey \} from '\.\.\/components\/ApiKeyMaskedSpan';/);
  });

  it("V-337 server-info rows: driver row 'playwright (chromium)' format when driver===playwright && playwright_browser truthy + version row 'X.Y.Z · gitsha7' format when git_sha !== 'unknown' (.slice(0,7) short-sha); both rows only render when serverInfo !== null", () => {
    expect(body).toMatch(
      /\{serverInfo !== null && \([ \t]*(?:\r?\n[ \t]*)?<>[ \t]*(?:\r?\n[ \t]*)?<Row label="Server driver">/,
    );
    expect(body).toMatch(
      /\{serverInfo\.driver\}[ \t]*(?:\r?\n[ \t]*)?\{serverInfo\.driver === 'playwright' && serverInfo\.playwright_browser[ \t]*(?:\r?\n[ \t]*)?\? ` \(\$\{serverInfo\.playwright_browser\}\)`[ \t]*(?:\r?\n[ \t]*)?: ''\}/,
    );
    expect(body).toMatch(
      /\{serverInfo\.version\}[ \t]*(?:\r?\n[ \t]*)?\{serverInfo\.git_sha !== 'unknown' \? ` · \$\{serverInfo\.git_sha\.slice\(0, 7\)\}` : ''\}/,
    );
  });

  it("ResultBlock: ok branch → status-ready tints + 'OK' section-label + durationMs ms display; fail branch → status-error tints + 'Failed' + errorKind '· {kind}' suffix conditional on errorKind !== undefined; both render Row helper Component with section-label + grid-cols-[10rem_1fr] layout", () => {
    expect(body).toMatch(
      /function Row\(\{ label, children \}: \{ label: string; children: React\.ReactNode \}\): JSX\.Element \{[ \t]*(?:\r?\n[ \t]*)?return \([ \t]*(?:\r?\n[ \t]*)?<div className="grid grid-cols-\[10rem_1fr\] items-center gap-3 text-sm">[ \t]*(?:\r?\n[ \t]*)?<span className="section-label">\{label\}<\/span>/,
    );
    expect(body).toMatch(
      /if \(result\.ok\) \{[ \t]*(?:\r?\n[ \t]*)?return \([ \t]*(?:\r?\n[ \t]*)?<div className="rounded-xl border border-status-ready\/30 bg-status-ready\/10 px-4 py-3">/,
    );
    expect(body).toMatch(
      /\{result\.errorKind !== undefined && \([ \t]*(?:\r?\n[ \t]*)?<span className="mono text-2xs text-ink-muted">· \{result\.errorKind\}<\/span>[ \t]*(?:\r?\n[ \t]*)?\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
