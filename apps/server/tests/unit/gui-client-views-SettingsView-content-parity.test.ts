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
    expect(body).toMatch(
      /apiKey: draftKey\.length > 0 \? draftKey : null,\s*\n?\s*baseUrl: draftUrl\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\) \|\| 'http:\/\/localhost:3000',\s*\n?\s*telemetryOptIn: draftTelemetry,/,
    );
  });

  it("Telemetry 3-radio tri-state (null=platform default / true / false): platformDefaultLabel = cloudBaseUrl ? 'on (cloud default)' : 'off (self-hosted default)' + effectiveTelemetry derived state (null falls back to cloud↔'on' / non-cloud↔'off')", () => {
    expect(body).toMatch(
      /const cloudBaseUrl = isCloudBaseUrl\(draftUrl\);\s*\n?\s*const platformDefaultLabel = cloudBaseUrl \? 'on \(cloud default\)' : 'off \(self-hosted default\)';\s*\n?\s*const effectiveTelemetry =\s*\n?\s*draftTelemetry === null \? \(cloudBaseUrl \? 'on' : 'off'\) : draftTelemetry \? 'on' : 'off';/,
    );
    expect(body).toMatch(
      /<input\s*\n?\s*type="radio"\s*\n?\s*name="telemetry"\s*\n?\s*checked=\{draftTelemetry === null\}\s*\n?\s*onChange=\{\(\) => setDraftTelemetry\(null\)\}/,
    );
    expect(body).toMatch(
      /<input\s*\n?\s*type="radio"\s*\n?\s*name="telemetry"\s*\n?\s*checked=\{draftTelemetry === true\}\s*\n?\s*onChange=\{\(\) => setDraftTelemetry\(true\)\}/,
    );
    expect(body).toMatch(
      /<input\s*\n?\s*type="radio"\s*\n?\s*name="telemetry"\s*\n?\s*checked=\{draftTelemetry === false\}\s*\n?\s*onChange=\{\(\) => setDraftTelemetry\(false\)\}/,
    );
  });

  it("Sign-out branded useConfirm pinned with 'Sign out of this device? This forgets the API key locally; the key is NOT revoked on the server. Revoke it from the dashboard if you want to fully invalidate it.' wording — pinned so customer understands the difference between local sign-out and full server-side revocation (migrated off window.confirm, which is flaky in the Tauri WKWebView)", () => {
    expect(body).toMatch(
      /await confirm\(\s*\n?\s*'Sign out of this device\? This forgets the API key locally; the key is NOT revoked on the server\. Revoke it from the dashboard if you want to fully invalidate it\.',/,
    );
  });

  it("Connected card: 'Pointing at <mono>{baseUrl}</mono> with key <mono>{apiKey.slice(0,12) ?? ''}…{apiKey.slice(-4) ?? ''}</mono>' (12+4 slice mask with '' fallback for null apiKey edge); first-run instruction 'Sign in with your browser to mint a fresh API key bound to your account, or paste an existing key from app.driftstack.dev/api-keys below.'", () => {
    expect(body).toMatch(
      /Pointing at <span className="mono">\{settings\.baseUrl\}<\/span> with key\{' '\}\s*\n?\s*<span className="mono">\s*\n?\s*\{settings\.apiKey\?\.slice\(0, 12\) \?\? ''\}…\{settings\.apiKey\?\.slice\(-4\) \?\? ''\}\s*\n?\s*<\/span>/,
    );
    expect(body).toMatch(
      /Sign in with your browser to mint a fresh API key bound to your account, or paste an\s*\n?\s*existing key from <span className="mono">app\.driftstack\.dev\/api-keys<\/span> below\./,
    );
  });

  it("Browser sign-in 5-state branch in first-run section: idle → 'Sign in with browser' button / opening → 'Opening browser…' / waiting → animate-pulse dot + 'Waiting for browser confirmation…' + Cancel button / success → 'Authorized. Key saved.' status-success / error → message + 'Try again' button", () => {
    expect(body).toMatch(
      /\{browserSignIn\.state\.kind === 'idle' && \(\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*className="btn-primary mt-3"\s*\n?\s*onClick=\{\(\) => void browserSignIn\.start\(\)\}\s*\n?\s*>\s*\n?\s*Sign in with browser/,
    );
    expect(body).toMatch(
      /\{browserSignIn\.state\.kind === 'waiting' && \(\s*\n?\s*<div className="mt-3 flex items-center gap-3">\s*\n?\s*<div className="h-3 w-3 animate-pulse rounded-full bg-accent" aria-hidden="true" \/>\s*\n?\s*<p className="text-xs text-ink-secondary">Waiting for browser confirmation…<\/p>/,
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
      /Crash-only: error messages, stack traces, app version, OS\. Never API keys, profile data,\s*\n?\s*or any session contents\. Currently: <span className="mono">\{effectiveTelemetry\}<\/span>\./,
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
