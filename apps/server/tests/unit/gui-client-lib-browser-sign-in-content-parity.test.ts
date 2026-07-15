// W474.C — drift guard for apps/gui-client/src/lib/browser-sign-in.ts.
// V-274 shared browser-OAuth state machine + V-328 deep-link
// primary path + V-534.A parseDeepLink delegation. Drift here
// either drops the 2s polling fallback (deep-link plugin
// unavailable on Linux/no-DE → customer hangs forever with no
// progress because polling never starts) or breaks the
// code+state CSRF guard on the deep-link path (attacker arms a
// driftstack:// URL with a code from another session — handler
// blindly exchanges and rebinds the wrong account).
//
//   • V-274 framing pinned: 'Shared browser-OAuth-sign-in state
//     machine.'
//   • V-328 framing pinned: 'extended with deep-link primary path.
//     When the dashboard completion page redirects to driftstack://
//     auth/callback?code=...&state=..., the OS hands off to this
//     app and the deep-link listener fires synchronously. The 2s
//     polling loop stays as a FALLBACK for platforms / installs
//     where the URL scheme registration didn't take (e.g. Linux
//     without a desktop env, Windows without HKCU write access).
//     Both paths converge on the same setState path.'
//   • Module constants: POLL_INTERVAL_MS = 2000 + POLL_TIMEOUT_MS
//     = 5 * 60 * 1000 (multiplied form, not literal 300000).
//   • InitiateResponse 4-field + ExchangeResponse 3-state union
//     ('pending' | 'bound' | 'expired') + api_key? + account_id?.
//   • BrowserSignInState 5-variant with waiting{code+userCode+state+
//     expiresAt}; UseBrowserSignInOptions: baseUrl + clientLabel?
//     + onSuccess + 3 test seams (__pollIntervalMs +
//     __pollTimeoutMs + __onOpenUrl) with V-328 framing on the
//     deep-link seam.
//   • generateBrowserSignInState: Uint8Array(24) + crypto.
//     getRandomValues + hex padStart(2,'0').
//   • baseUrl trim().replace(/\/+$/,'') strip + clientLabel
//     default `Driftstack desktop on ${navigator.platform}`.
//   • deepLinkUnlistenRef stop() cleanup + onUnmount cleanup.
//   • handleDeepLink: parseDeepLink + result.ok guard +
//     kind 'cli-authorize' guard + code+state CSRF match;
//     pollOnce: 400-499 stop+detail, 'expired' status →
//     'Authorization expired.' message, 'bound' + api_key +
//     account_id → setState success + await onSuccess.
//   • settledRef stopped-flow guard: useRef(false), set true in
//     stop(), reset false in run(), checked (early-return) right
//     after the exchange fetch — a late in-flight poll can't
//     overwrite a settled state (the deep-link fast-path consumes
//     the one-shot code, so an in-flight 2s-poll lands on 'expired';
//     and a late 'bound' must not sign in after cancel).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/browser-sign-in.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W474.C apps/gui-client/src/lib/browser-sign-in.ts content parity', () => {
  const body = read(LIB);

  it("V-274 framing pinned: 'V-274 — Shared browser-OAuth-sign-in state machine.' + V-328 framing pinned: 'extended with deep-link primary path. When the dashboard completion page redirects to driftstack://auth/callback?code=...&state=..., the OS hands off to this app and the deep-link listener fires synchronously. The 2s polling loop stays as a FALLBACK for platforms / installs where the URL scheme registration didn't take (e.g. Linux without a desktop env, Windows without HKCU write access). Both paths converge on the same setState path.'", () => {
    expect(body).toMatch(/\/\/ V-274 — Shared browser-OAuth-sign-in state machine\./);
    expect(body).toMatch(
      /\/\/ V-328 — extended with deep-link primary path\. When the dashboard\s*\n?\s*\/\/ completion page redirects to driftstack:\/\/auth\/callback\?code=\.\.\.&\s*\n?\s*\/\/ state=\.\.\., the OS hands off to this app and the deep-link listener\s*\n?\s*\/\/ fires synchronously\. The 2s polling loop stays as a FALLBACK for\s*\n?\s*\/\/ platforms \/ installs where the URL scheme registration didn't\s*\n?\s*\/\/ take \(e\.g\. Linux without a desktop env, Windows without HKCU\s*\n?\s*\/\/ write access\)\. Both paths converge on the same setState path\./,
    );
  });

  it('Module constants pinned: POLL_INTERVAL_MS = 2000 + POLL_TIMEOUT_MS = 5 * 60 * 1000 (multiplied form for readability — not the literal 300000) — pinned so polling cadence and 5-minute backstop are pinned at module scope, not a hard-coded interior literal', () => {
    expect(body).toMatch(/const POLL_INTERVAL_MS = 2000;/);
    expect(body).toMatch(/const POLL_TIMEOUT_MS = 5 \* 60 \* 1000;/);
  });

  it('InitiateResponse includes the separate user_code + ExchangeResponse retains the 3-status union', () => {
    expect(body).toMatch(
      /interface InitiateResponse \{\s*\n?\s*code: string;\s*\n?\s*user_code: string;\s*\n?\s*browser_url: string;\s*\n?\s*expires_at: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /interface ExchangeResponse \{\s*\n?\s*status: 'pending' \| 'bound' \| 'expired';\s*\n?\s*api_key\?: string;\s*\n?\s*account_id\?: string;\s*\n?\s*\}/,
    );
  });

  it('BrowserSignInState carries userCode while waiting and options retain the timing/deep-link seams', () => {
    expect(body).toMatch(
      /export type BrowserSignInState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'opening' \}\s*\n?\s*\| \{ kind: 'waiting'; code: string; userCode: string; state: string; expiresAt: number \}\s*\n?\s*\| \{ kind: 'success' \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
    expect(body).toMatch(
      /export interface UseBrowserSignInOptions \{\s*\n?\s*baseUrl: string;\s*\n?\s*clientLabel\?: string;\s*\n?\s*onSuccess: \(apiKey: string, accountId: string\) => void \| Promise<void>;\s*\n?\s*\/\*\* Test-only: override the 2s poll cadence\. \*\/\s*\n?\s*__pollIntervalMs\?: number;\s*\n?\s*\/\*\* Test-only: override the 5-minute backstop\. \*\/\s*\n?\s*__pollTimeoutMs\?: number;/,
    );
    expect(body).toMatch(
      /\* V-328 test seam: override the deep-link listener registration so\s*\n?\s*\*\s+unit tests can simulate a deep-link arrival without booting the\s*\n?\s*\*\s+Tauri runtime\. Production passes undefined and the real\s*\n?\s*\*\s+`@tauri-apps\/plugin-deep-link\.onOpenUrl` is used\./,
    );
    expect(body).toMatch(
      /__onOpenUrl\?: \(handler: \(urls: string\[\]\) => void\) => Promise<\(\) => void>;/,
    );
  });

  it("generateBrowserSignInState exported: Uint8Array(24) + crypto.getRandomValues + Array.from + toString(16).padStart(2,'0') hex join — pinned so the 24-byte (48-hex-char) CSRF token surface isn't accidentally shrunk", () => {
    expect(body).toMatch(
      /export function generateBrowserSignInState\(\): string \{\s*\n?\s*const bytes = new Uint8Array\(24\);\s*\n?\s*crypto\.getRandomValues\(bytes\);\s*\n?\s*return Array\.from\(bytes, \(b\) => b\.toString\(16\)\.padStart\(2, '0'\)\)\.join\(''\);\s*\n?\s*\}/,
    );
  });

  it('Initiate flow maps remote failures safely, opens the browser, and exposes user_code only in waiting state', () => {
    expect(body).toMatch(
      /const trimmedUrl = opts\.baseUrl\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\);/,
    );
    expect(body).toMatch(
      /const initiateRes = await fetchWithDeadline\(`\$\{trimmedUrl\}\/v1\/auth\/cli-authorize\/initiate`, \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json' \},\s*\n?\s*body: JSON\.stringify\(\{\s*\n?\s*state: stateToken,\s*\n?\s*client_label: opts\.clientLabel \?\? `Driftstack desktop on \$\{navigator\.platform\}`,\s*\n?\s*\}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /throw Object\.assign\(new Error\(await readApiErrorMessage\(initiateRes\)\), \{\s*customerSafe: true,\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(!\/\^\[A-HJ-NP-Z2-9\]\{4\}-\[A-HJ-NP-Z2-9\]\{4\}\$\/\.test\(initiate\.user_code\)\) \{[\s\S]*?does not support secure browser sign-in[\s\S]*?\}/,
    );
    expect(body).toMatch(
      /setState\(\{\s*\n?\s*kind: 'waiting',\s*\n?\s*code: initiate\.code,\s*\n?\s*userCode: initiate\.user_code,\s*\n?\s*state: stateToken,\s*\n?\s*expiresAt,\s*\n?\s*\}\);/,
    );
  });

  it("Deep-link seam wiring: onUrl = opts.__onOpenUrl ?? onOpenUrl (V-328 test seam fallthrough to real plugin) + handler iterates urls + handleDeepLink with trimmedUrl + initiate.code + stateToken; deepLinkUnlistenRef stop() cleanup with try/catch swallow comment 'the listener may have already been torn down' + on-unmount cleanup useEffect", () => {
    expect(body).toMatch(
      /const onUrl = opts\.__onOpenUrl \?\? onOpenUrl;\s*\n?\s*const unlisten = await onUrl\(\(urls\) => \{\s*\n?\s*for \(const url of urls\) \{\s*\n?\s*void handleDeepLink\(url, trimmedUrl, initiate\.code, stateToken\);\s*\n?\s*\}\s*\n?\s*\}\);\s*\n?\s*deepLinkUnlistenRef\.current = unlisten;/,
    );
    expect(body).toMatch(
      /if \(deepLinkUnlistenRef\.current !== null\) \{\s*\n?\s*try \{\s*\n?\s*deepLinkUnlistenRef\.current\(\);\s*\n?\s*\} catch \{\s*\n?\s*\/\* swallow — the listener may have already been torn down \*\/\s*\n?\s*\}\s*\n?\s*deepLinkUnlistenRef\.current = null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Cleanup on unmount\.\s*\n?\s*useEffect\(\(\) => \{\s*\n?\s*return \(\) => stop\(\);\s*\n?\s*\}, \[\]\);/,
    );
  });

  it("handleDeepLink CSRF guard: parseDeepLink(rawUrl) + !result.ok silent skip + result.payload.kind !== 'cli-authorize' silent skip + code !== expectedCode || state !== expectedState silent skip (CSRF guard against arbitrary attacker-armed driftstack:// URL) + pollOnce delegation", () => {
    expect(body).toMatch(
      /async function handleDeepLink\(\s*\n?\s*rawUrl: string,\s*\n?\s*serverUrl: string,\s*\n?\s*expectedCode: string,\s*\n?\s*expectedState: string,\s*\n?\s*\): Promise<void> \{\s*\n?\s*const result = parseDeepLink\(rawUrl\);\s*\n?\s*if \(!result\.ok\) return;\s*\n?\s*if \(result\.payload\.kind !== 'cli-authorize'\) return;\s*\n?\s*if \(result\.payload\.code !== expectedCode \|\| result\.payload\.state !== expectedState\) return;\s*\n?\s*await pollOnce\(serverUrl, expectedCode, expectedState\);\s*\n?\s*\}/,
    );
  });

  it('pollOnce branches: POST /v1/auth/cli-authorize/exchange with {code, state: stateToken} + !res.ok 4xx → stop + fixed typed/status copy + pending/expired/bound terminal handling + silent network retry', () => {
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{serverUrl\}\/v1\/auth\/cli-authorize\/exchange`, \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json' \},\s*\n?\s*body: JSON\.stringify\(\{ code, state: stateToken \}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(res\.status >= 400 && res\.status < 500\) \{\s*\n?\s*stop\(\);\s*\n?\s*setState\(\{\s*\n?\s*kind: 'error',\s*\n?\s*message: await readApiErrorMessage\(res\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(body\.status === 'expired'\) \{[\s\S]*?if \(body\.status === 'bound' && body\.api_key && body\.account_id\) \{\s*\n?\s*stop\(\);\s*\n?\s*try \{\s*\n?\s*await opts\.onSuccess\(body\.api_key, body\.account_id\);[\s\S]*?catch \(error\) \{[\s\S]*?kind: 'error',[\s\S]*?humanizeError\([\s\S]*?return;\s*\n?\s*\}\s*\n?\s*setState\(\{ kind: 'success' \}\);/,
    );
    expect(body).toMatch(/\/\/ network blip — silent retry/);
  });

  it('never promotes remote problem detail/title to browser sign-in copy', () => {
    expect(body).not.toMatch(/body\.detail \?\?/);
    expect(body).not.toContain('readBoundedDiagnosticJson');
    expect(body).toContain("import { readApiErrorMessage } from './api-errors';");
  });

  it('Poll timer wiring: setInterval cadence opts.__pollIntervalMs ?? POLL_INTERVAL_MS + setTimeout backstop opts.__pollTimeoutMs ?? POLL_TIMEOUT_MS firing stop() + setState error \'Authorization expired. Click "Sign in with browser" to try again.\'', () => {
    expect(body).toMatch(
      /pollHandleRef\.current = window\.setInterval\(\(\) => \{\s*\n?\s*void pollOnce\(trimmedUrl, initiate\.code, stateToken\);\s*\n?\s*\}, opts\.__pollIntervalMs \?\? POLL_INTERVAL_MS\);\s*\n?\s*timeoutHandleRef\.current = window\.setTimeout\(\(\) => \{\s*\n?\s*stop\(\);\s*\n?\s*setState\(\{\s*\n?\s*kind: 'error',\s*\n?\s*message: 'Authorization expired\. Click "Sign in with browser" to try again\.',\s*\n?\s*\}\);\s*\n?\s*\}, opts\.__pollTimeoutMs \?\? POLL_TIMEOUT_MS\);/,
    );
  });

  it("settledRef stopped-flow guard: const settledRef = useRef(false) + settledRef.current = true in stop() + settledRef.current = false reset in run() + `if (settledRef.current) return;` early-return after the exchange fetch — pinned so a late in-flight poll can't overwrite a settled state (one-shot-consumed code → 'expired' after deep-link success; 'bound' after cancel)", () => {
    expect(body).toMatch(/const settledRef = useRef\(false\);/);
    expect(body).toMatch(/settledRef\.current = true;/);
    expect(body).toMatch(/settledRef\.current = false;/);
    expect(body).toMatch(/if \(settledRef\.current\) return;/);
  });

  it('bounds and cancels transport while keeping exchange polling single-flight', () => {
    expect(body).toMatch(/const REQUEST_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(
      /const activeControllersRef = useRef<Set<AbortController>>\(new Set\(\)\);/,
    );
    expect(body).toMatch(
      /for \(const controller of activeControllersRef\.current\) controller\.abort\(\);/,
    );
    expect(body).toMatch(/if \(pollInFlightRef\.current \|\| settledRef\.current\) return;/);
    expect(body).toMatch(/finally \{\s*\n?\s*pollInFlightRef\.current = false;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
