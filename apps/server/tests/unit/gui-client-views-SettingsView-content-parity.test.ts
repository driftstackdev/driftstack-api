// W483.B — drift guard for apps/gui-client/src/views/SettingsView.tsx.
// Settings view: API key + base URL + telemetry. Drift here
// either drops the V-241 OS-keychain framing (a refactor moves
// keys back to localStorage and the customer's API key is
// suddenly readable by any other app that can read the same
// origin) or breaks the V-242 3-way telemetry tri-state (null
// platform default / true / false — collapses to a binary
// boolean and self-hosted customers lose the 'use platform
// default = off' contract).
//
//   • V-241 framing pinned: 'API key now stored in OS keychain
//     (macOS Keychain / Windows Credential Manager / Linux
//     Secret Service); the masked input edits the keychain
//     entry transparently via Tauri commands.'
//   • V-242 framing pinned: 'telemetry toggle — Sentry crash-
//     only opt-in. Defaults ON for cloud customers, OFF for
//     self-hosted. Customer can override either direction.'
//   • V-272 framing pinned: 'account info block + sign-out
//     button. First-run hint rewritten to point at the V-268
//     browser sign-in flow instead of the stale "npm run admin:
//     create-key" instruction.'
//   • Telemetry 3-radio: null (platform default) / true / false
//     with platformDefaultLabel + effectiveTelemetry derived
//     state.
//   • baseUrl default fallback 'http://localhost:7780' on save.
//   • Sign-out window.confirm with 'forgets the API key locally;
//     the key is NOT revoked on the server' wording.
//   • V-324 help links: status / docs / support@driftstack.dev
//     mailto.
//   • Browser sign-in 5-state branch (idle / opening / waiting
//     / success / error).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/SettingsView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W483.B apps/gui-client/src/views/SettingsView.tsx content parity', () => {
  const body = read(LIB);

  it('connection and key checks are controller-owned, sequence-gated, and invalidated on lifecycle changes', () => {
    expect(body).toContain('const validateControllerRef = useRef<AbortController | null>(null);');
    expect(body).toContain('const connectionTestTokenRef = useRef(0);');
    expect(body).toContain('connectionTestControllerRef.current?.abort();');
    expect(body).toContain('if (connectionTestTokenRef.current !== token) return;');
    expect(body).toContain('validateControllerRef.current?.abort();');
    expect(body).toContain('invalidateConnectionTest();');
    expect(body).toContain('invalidateKeyValidation();');
  });

  it('serializes settings persistence before React state commits and surfaces a safe failure', () => {
    expect(body).toContain('const saveInFlightRef = useRef(false);');
    expect(body).toContain('if (startUrlInvalid || saveInFlightRef.current) return;');
    expect(body).toMatch(
      /saveInFlightRef\.current = true;[\s\S]*?await update\([\s\S]*?catch \(err\) \{[\s\S]*?title: "Couldn't save settings"[\s\S]*?return;[\s\S]*?finally \{[\s\S]*?saveInFlightRef\.current = false;/,
    );
  });

  it("V-241 + V-242 + V-272 framing pinned: 'V-241: API key now stored in OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service); the masked input edits the keychain entry transparently via Tauri commands.' + 'V-242: telemetry toggle — Sentry crash-only opt-in. Defaults ON for cloud customers, OFF for self-hosted. Customer can override either direction.' + 'V-272: account info block + sign-out button. First-run hint rewritten to point at the V-268 browser sign-in flow instead of the stale \"npm run admin:create-key\" instruction.'", () => {
    expect(body).toMatch(
      /\/\/ V-241: API key now stored in OS keychain \(macOS Keychain \/ Windows\s*\n?\s*\/\/ Credential Manager \/ Linux Secret Service\); the masked input edits\s*\n?\s*\/\/ the keychain entry transparently via Tauri commands\./,
    );
    expect(body).toMatch(
      /\/\/ V-242: telemetry toggle — Sentry crash-only opt-in\. Defaults ON for\s*\n?\s*\/\/ cloud customers, OFF for self-hosted\. Customer can override either\s*\n?\s*\/\/ direction\./,
    );
    expect(body).toMatch(
      /\/\/ V-272: account info block \+ sign-out button\. First-run hint\s*\n?\s*\/\/ rewritten to point at the V-268 browser sign-in flow instead of the\s*\n?\s*\/\/ stale "npm run admin:create-key" instruction\./,
    );
  });

  it("isFirstRun = settings.apiKey === null gate; V-274 inline browser sign-in: baseUrl.trim().replace(trailing-slash) || settings.baseUrl + onSuccess updates apiKey + saves savedAt; handleSave: baseUrl fallback 'http://localhost:7780' default + apiKey: draftKey.length > 0 ? draftKey : null", () => {
    expect(body).toMatch(/const isFirstRun = settings\.apiKey === null;/);
    expect(body).toMatch(
      /\/\/ V-274 — inline browser sign-in \(re-uses V-268 plumbing\)\. Lets the\s*\n?\s*\/\/ customer re-authorize without restarting the app post-Sign-out\./,
    );
    expect(body).toMatch(
      /const browserSignIn = useBrowserSignIn\(\{\s*\n?\s*baseUrl: draftUrl\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\) \|\| settings\.baseUrl,\s*\n?\s*onSuccess: async \(issuedKey, _accountId\) => \{/,
    );
    // 2026-05-20 — baseUrl fallback shifted 7780→3000 (SDK client default).
    // W577 — handleSave hoists the normalized URL (it's reused by the
    // post-save key validation), so the fallback lives on `const url`.
    expect(body).toMatch(
      /const url = draftUrl\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\) \|\| 'http:\/\/localhost:3000';/,
    );
    expect(body).toMatch(
      /apiKey: draftKey\.length > 0 \? draftKey : null,\s*\n?\s*baseUrl: url,\s*\n?\s*telemetryOptIn: draftTelemetry,/,
    );
  });

  it('W577: post-save key validation — non-blocking persist, then GET /v1/account/me with the saved key; 401 message is mode-aware (self-hosted says the key must come from that server, cloud points at app.driftstack.dev/api-keys); unreachable falls to diagnosticFetchError', () => {
    expect(body).toMatch(/fetch\(`\$\{url\}\/v1\/account\/me`,/);
    expect(body).toMatch(/authorization: `Bearer \$\{draftKey\}`/);
    expect(body).toMatch(/res\.status === 401/);
    expect(body).toMatch(
      /In self-hosted mode the key must be created on that server's own dashboard — a key from app\.driftstack\.dev won't authenticate here\./,
    );
    expect(body).toMatch(
      /Double-check it, or create a new one at app\.driftstack\.dev\/api-keys\./,
    );
    expect(body).toMatch(/Saved\. Key authenticated ✓/);
  });

  it("Telemetry 3-radio tri-state (null=platform default / true / false): platformDefaultLabel = cloudBaseUrl ? 'on (cloud default)' : 'off (self-hosted default)' + effectiveTelemetry derived state (null falls back to cloud↔'on' / non-cloud↔'off')", () => {
    expect(body).toMatch(
      /const cloudBaseUrl = isCloudBaseUrl\(draftUrl\);\s*\n?\s*const platformDefaultLabel = cloudBaseUrl \? 'on \(cloud default\)' : 'off \(self-hosted default\)';\s*\n?\s*const effectiveTelemetry =\s*\n?\s*draftTelemetry === null \? \(cloudBaseUrl \? 'on' : 'off'\) : draftTelemetry \? 'on' : 'off';/,
    );
    // The 3 tri-state radios now render through a RadioRow helper (2026-06-24 fancy
    // restyle) that preserves the native radio semantics verbatim. Pin the helper's
    // native <input> (type/name/className/checked/onChange unchanged) + the 3 tri-state
    // call sites (the load-bearing null/true/false → setDraftTelemetry wiring).
    expect(body).toMatch(
      /<input\s*\n?\s*type="radio"\s*\n?\s*name="telemetry"\s*\n?\s*className="accent-accent"\s*\n?\s*checked=\{checked\}\s*\n?\s*onChange=\{onChange\}/,
    );
    expect(body).toMatch(
      /<RadioRow\s+checked=\{draftTelemetry === null\} onChange=\{\(\) => setDraftTelemetry\(null\)\}>/,
    );
    expect(body).toMatch(
      /<RadioRow\s+checked=\{draftTelemetry === true\} onChange=\{\(\) => setDraftTelemetry\(true\)\}>/,
    );
    expect(body).toMatch(
      /checked=\{draftTelemetry === false\}\s*\n?\s*onChange=\{\(\) => setDraftTelemetry\(false\)\}/,
    );
  });

  it("Sign-out branded useConfirm pinned with 'Sign out of this device? This forgets the API key locally; the key is NOT revoked on the server. Revoke it from the dashboard if you want to fully invalidate it.' wording — pinned so customer understands the difference between local sign-out and full server-side revocation (migrated off window.confirm, which is flaky in the Tauri WKWebView)", () => {
    expect(body).toMatch(
      /await confirm\(\s*\n?\s*'Sign out of this device\? This forgets the API key locally; the key is NOT revoked on the server\. Revoke it from the dashboard if you want to fully invalidate it\.',/,
    );
  });

  it("Connected card: 'Pointing at <mono>{baseUrl}</mono> with key <mono>{maskApiKey(settings.apiKey)}</mono>' — the inline slice(0,12)+slice(-4) mask was replaced by the shared, prefix-aware maskApiKey helper (imported from ../components/ApiKeyMaskedSpan; strips the known ds_live_ prefix + shows only 4+4 of the body) because the old inline slice leaked 16 contiguous real chars (audit); first-run instruction 'Sign in with your browser to mint a fresh API key bound to your account, or paste an existing key from app.driftstack.dev/api-keys below.'", () => {
    expect(body).toMatch(/import \{ maskApiKey \} from '\.\.\/components\/ApiKeyMaskedSpan';/);
    expect(body).toMatch(
      /Pointing at <span className="mono">\{settings\.baseUrl\}<\/span> with key\{' '\}[\s\S]{0,400}?<span className="mono">\{maskApiKey\(settings\.apiKey\)\}<\/span>\./,
    );
    expect(body).not.toMatch(
      /\{settings\.apiKey\?\.slice\(0, 12\) \?\? ''\}…\{settings\.apiKey\?\.slice\(-4\) \?\? ''\}/,
    );
    // W577 — the first-run hint is now mode-aware: cloud keeps the
    // app.driftstack.dev/api-keys pointer; self-hosted explains the key
    // must come from the customer's own server (deployment-bound keys).
    expect(body).toMatch(
      /Sign in with your browser to mint a fresh API key bound to your account, or paste an\s*\n?\s*existing key from <span className="mono">app\.driftstack\.dev\/api-keys<\/span> below\./,
    );
    expect(body).toMatch(
      /Paste a key created on your own server's dashboard\. A key from\{' '\}\s*\n?\s*<span className="mono">app\.driftstack\.dev<\/span> won't authenticate against a\s*\n?\s*self-hosted server — keys are bound to the deployment that minted them\./,
    );
  });

  it('Browser sign-in waiting state displays the separate verification code and anti-phishing copy', () => {
    expect(body).toMatch(
      /\{browserSignIn\.state\.kind === 'idle' && \(\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*className="btn-primary mt-3"\s*\n?\s*onClick=\{\(\) => void browserSignIn\.start\(\)\}\s*\n?\s*>\s*\n?\s*Sign in with browser/,
    );
    expect(body).toMatch(
      /\{browserSignIn\.state\.kind === 'waiting' && \([\s\S]*?Enter this verification code in the browser\.[\s\S]*?Never share it with someone who[\s\S]*?\{browserSignIn\.state\.userCode\}/,
    );
    expect(body).toMatch(
      /\{browserSignIn\.state\.kind === 'success' && \(\s*\n?\s*<p className="mt-3 text-xs text-status-success">Authorized\. Key saved\.<\/p>/,
    );
  });

  it("API key field: reveal toggle (password ↔ text input) + 'Hide'/'Show' button + autoComplete='off' + spellCheck={false}; framing 'Stored in your OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service); never sent anywhere except your configured API server.'", () => {
    expect(body).toMatch(
      /<input\s*\n?\s*type=\{reveal \? 'text' : 'password'\}\s*\n?\s*value=\{draftKey\}/,
    );
    expect(body).toMatch(
      /<button type="button" className="btn-secondary" onClick=\{\(\) => setReveal\(\(r\) => !r\)\}>\s*\n?\s*\{reveal \? 'Hide' : 'Show'\}/,
    );
    expect(body).toMatch(
      /Stored in your OS keychain \(macOS Keychain \/ Windows Credential Manager \/ Linux Secret\s*\n?\s*Service\); never sent anywhere except your configured API server\./,
    );
  });

  it("Crash-reports framing pinned: 'Crash-only: error messages, stack traces, app version, OS. Never API keys, profile data, or any session contents.' — pinned so customer knows exactly what telemetry covers + currently-effective state surfaced as <mono>{effectiveTelemetry}</mono>", () => {
    expect(body).toMatch(
      /Crash-only: error messages, stack traces, app version, OS\. Never API keys, profile\s*\n?\s*data, or any session contents\. Currently:\{' '\}\s*\n?\s*<span className="mono">\{effectiveTelemetry\}<\/span>\./,
    );
  });

  it("V-324 help links pinned: 'Status (uptime + incidents)' status.driftstack.dev + 'Docs (quickstart + reference)' docs.driftstack.dev + 'support@driftstack.dev' mailto — pinned so customers don't dig through marketing site for support context; framing comment 'help links so customers don't have to dig through the marketing site to find status / docs / support contact from inside the app.'", () => {
    expect(body).toMatch(
      /\{\/\* V-324 — help links so customers don't have to dig through\s*\n?\s*\s+the marketing site to find status \/ docs \/ support contact\s*\n?\s*\s+from inside the app\. \*\/\}/,
    );
    expect(body).toMatch(/href="https:\/\/status\.driftstack\.dev"/);
    expect(body).toMatch(/href="https:\/\/docs\.driftstack\.dev"/);
    expect(body).toMatch(/<a href="mailto:support@driftstack\.dev"/);
  });

  it('Field subcomponent: label + children with section-label header — pinned so the form-field convention stays consistent', () => {
    expect(body).toMatch(
      /function Field\(\{ label, children \}: \{ label: string; children: React\.ReactNode \}\): JSX\.Element \{\s*\n?\s*return \(\s*\n?\s*<label className="flex flex-col gap-1\.5">\s*\n?\s*<span className="section-label">\{label\}<\/span>\s*\n?\s*\{children\}\s*\n?\s*<\/label>\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
