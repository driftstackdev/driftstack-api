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

  it("V-337 framing pinned: 'surface the server's version when we can reach the public /version endpoint, so a customer can tell which build they are talking to without running /version manually. The driver mode the endpoint also reports is deliberately NOT shown (2026-09-15).'", () => {
    expect(body).toMatch(
      /\/\/ V-337 — surface the server's version when we can reach the public[ \t]*(?:\r?\n[ \t]*)?\/\/ \/version endpoint, so a customer can tell which build they are[ \t]*(?:\r?\n[ \t]*)?\/\/ talking to without running \/version manually\. The driver mode the[ \t]*(?:\r?\n[ \t]*)?\/\/ endpoint also reports is deliberately NOT shown \(2026-09-15\)\./,
    );
  });

  it('CheckResult 3-field (ok: boolean + durationMs: number + detail: string — no errorKind: the raw SDK kind is wire vocabulary, not customer copy) + ServerVersion 1-field (version only — git_sha / driver / playwright_browser describe how the server runs and are never read; owner directive 2026-09-15)', () => {
    expect(body).toMatch(
      /interface CheckResult \{[ \t]*(?:\r?\n[ \t]*)?ok: boolean;[ \t]*(?:\r?\n[ \t]*)?durationMs: number;[ \t]*(?:\r?\n[ \t]*)?detail: string;[ \t]*(?:\r?\n[ \t]*)?\}/,
    );
    expect(body).toMatch(
      /interface ServerVersion \{[ \t]*(?:\r?\n[ \t]*)?version: string;[ \t]*(?:\r?\n[ \t]*)?\}/,
    );
    expect(body).not.toMatch(/errorKind/);
    expect(body).not.toMatch(/playwright_browser/);
  });

  it('/version fetch effect is bounded, cache-fresh, and aborts on URL change/unmount', () => {
    expect(body).toMatch(/setServerInfo\(null\);/);
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
    // 2026-09-15: the result is no longer named — the success line no longer
    // prints the page size, so the call is awaited for its round-trip only.
    expect(body).toContain('await client.sessions.list({ limit: 1 });');
    expect(body).toContain('const durationMs = Math.round(performance.now() - start);');
    expect(body).toContain("detail: 'Connected — your API key works.',");
    expect(body).toContain(
      "'The connection check failed. Check the server URL and API key in Settings, then try again.',",
    );
    expect(body).toContain('setResult({ ok: false, durationMs, detail });');
    expect(body).toMatch(/if \(!client \|\| checkInFlightRef\.current\) return;/);
    expect(body).toMatch(/const generation = authorityGenerationRef\.current;/);
    expect(body).toMatch(/if \(generation !== authorityGenerationRef\.current\) return;/);
    expect(body).toMatch(
      /finally \{[ \t]*(?:\r?\n[ \t]*)?if \(generation === authorityGenerationRef\.current\) \{[ \t]*(?:\r?\n[ \t]*)?checkInFlightRef\.current = false;[ \t]*(?:\r?\n[ \t]*)?setRunning\(false\);/,
    );
    expect(body).toMatch(
      /disabled=\{!client \|\| running\}[ \t]*(?:\r?\n[ \t]*)?aria-busy=\{running\}/,
    );
    expect(body).not.toContain("err instanceof Error ? err.message : 'unknown error'");
  });

  it('settings authority clears stale diagnostics and invalidates prior check completions', () => {
    expect(body).toMatch(/const authorityGenerationRef = useRef\(0\);/);
    expect(body).toMatch(/const checkInFlightRef = useRef\(false\);/);
    expect(body).toMatch(
      /const generation = \+\+authorityGenerationRef\.current;[\s\S]*?checkInFlightRef\.current = false;[\s\S]*?setRunning\(false\);[\s\S]*?setResult\(null\);/,
    );
    expect(body).toMatch(/\}, \[client, settings\.apiKey, settings\.baseUrl\]\);/);
  });

  it("API-key masking + 'not set' fallback: settings.apiKey === null → 'not set — configure under Settings' in text-status-error else maskApiKey(settings.apiKey) — the shared, prefix-aware mask (consistency standardization, replacing the old non-standard inline slice(0,8)…slice(-4)); apiKey unmasked has 'configure under Settings' nudge so user knows where to set it", () => {
    expect(body).toMatch(
      /\{settings\.apiKey === null \? \([ \t]*(?:\r?\n[ \t]*)?<span className="text-status-error">not set — configure under Settings<\/span>[ \t]*(?:\r?\n[ \t]*)?\) : \([\s\S]*?maskApiKey\(settings\.apiKey\)[ \t]*(?:\r?\n[ \t]*)?\)\}/,
    );
  });
  it('imports the shared maskApiKey from ApiKeyMaskedSpan (prefix-aware mask used everywhere a key is shown)', () => {
    expect(body).toMatch(/import \{ maskApiKey \} from '\.\.\/components\/ApiKeyMaskedSpan';/);
  });

  it("V-337 server-info row: ONLY a 'Server version' row, version typeof-GUARDED (a 200 whose version is missing/typeless renders '—', never crashes); no 'Server driver' row and no git_sha suffix — the driver mode and commit hash are how the server runs, not customer copy (owner directive 2026-09-15); the row only renders when serverInfo !== null", () => {
    expect(body).toMatch(
      /\{serverInfo !== null && \([ \t]*(?:\r?\n[ \t]*)?<Row label="Server version">[ \t]*(?:\r?\n[ \t]*)?<span className="mono text-ink-secondary">[ \t]*(?:\r?\n[ \t]*)?\{typeof serverInfo\.version === 'string' \? serverInfo\.version : '—'\}/,
    );
    expect(body).not.toMatch(/<Row label="Server driver">/);
    expect(body).not.toMatch(/git_sha/);
  });

  it("ResultBlock: ok branch → status-ready tints + 'OK' section-label + durationMs ms display; fail branch → status-error tints + 'Failed' + the humanized detail ONLY (no raw error-kind chip — wire vocabulary is not customer copy); both render Row helper Component with section-label + grid-cols-[10rem_1fr] layout", () => {
    expect(body).toMatch(
      /function Row\(\{ label, children \}: \{ label: string; children: React\.ReactNode \}\): JSX\.Element \{[ \t]*(?:\r?\n[ \t]*)?return \([ \t]*(?:\r?\n[ \t]*)?<div className="grid grid-cols-\[10rem_1fr\] items-center gap-3 text-sm">[ \t]*(?:\r?\n[ \t]*)?<span className="section-label">\{label\}<\/span>/,
    );
    expect(body).toMatch(
      /if \(result\.ok\) \{[ \t]*(?:\r?\n[ \t]*)?return \([ \t]*(?:\r?\n[ \t]*)?<div className="rounded-xl border border-status-ready\/30 bg-status-ready\/10 px-4 py-3">/,
    );
    expect(body).toMatch(
      /<span className="section-label text-status-error">Failed<\/span>[ \t]*(?:\r?\n[ \t]*)?<span className="mono text-2xs text-ink-muted">\{result\.durationMs\} ms<\/span>[ \t]*(?:\r?\n[ \t]*)?<\/div>/,
    );
    expect(body).not.toMatch(/result\.errorKind/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
