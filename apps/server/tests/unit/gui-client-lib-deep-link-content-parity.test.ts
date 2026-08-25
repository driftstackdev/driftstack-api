// W467.A — drift guard for apps/gui-client/src/lib/deep-link.ts.
// `driftstack://` custom-scheme deep-link parser + dispatcher.
// Drift here either drops the 'unknown' fallback branch
// (forward-compat from a newer dashboard issuing an unrecognized
// deep-link kind crashes the GUI instead of being silently
// dropped) or breaks the missing-required-param guards
// (a malformed callback URL crashes the CLI auth flow mid-token
// exchange and the customer's session is left in a broken state).
//
//   • Scheme framing pinned: 'The Tauri shell registers
//     driftstack:// as a custom URL scheme so the browser can hand
//     control back to the desktop app after a flow completes (CLI
//     authorization, recording load, profile import, etc).' +
//     '@tauri-apps/plugin-deep-link.onOpenUrl fires whenever the
//     OS dispatches one of these URLs to the running instance.'
//   • Single-source framing pinned: 'typed, single-source parser
//     every caller uses to turn the raw URL string into a
//     discriminated payload. Each consumer (CLI auth flow, profile
//     importer, recording loader) reads the kind discriminant and
//     acts on the typed fields, instead of each caller hand-rolling
//     URL parsing + string-matching.'
//   • Scheme shape framing pinned: 'driftstack://<host>/<path>?
//     <query>' + 'host partitions the namespace; path partitions
//     within the host.'
//   • Forward-compat framing pinned: 'Unknown host/path
//     combinations parse to { kind: unknown } and callers SHOULD
//     ignore them — the OS may dispatch a URL the running app
//     version doesn't understand (forward-compat from a newer
//     dashboard issuing a deep-link the older GUI installer
//     doesn't know about yet).'
//   • DeepLinkPayload 5-variant union (cli-authorize + session-open
//     + recording-open + profile-import + unknown).
//   • DeepLinkParseError reason 3-union ('malformed-url'|
//     'wrong-scheme'|'missing-required-param').
//   • REQUIRED_SCHEME = 'driftstack:'.
//   • parseDeepLink: new URL(rawUrl) catch → malformed-url;
//     wrong-scheme guard; 4-host branches with required-param
//     guards; unknown fallback at bottom.
//   • dispatchDeepLink: 'Errors and unknown payloads are silently
//     dropped to keep the deep-link channel forward-compatible (a
//     newer dashboard issuing an unknown deep-link kind doesn't
//     make the GUI crash or show a noisy error toast).' + 5-case
//     switch with router-optional dispatch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/deep-link.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W467.A apps/gui-client/src/lib/deep-link.ts content parity', () => {
  const body = read(LIB);

  it("Scheme framing pinned: 'Deep-link URL parser for `driftstack://` custom-scheme handoffs.' + 'The Tauri shell registers driftstack:// as a custom URL scheme so the browser can hand control back to the desktop app after a flow completes (CLI authorization, recording load, profile import, etc).' + '@tauri-apps/plugin-deep-link.onOpenUrl fires whenever the OS dispatches one of these URLs to the running instance.'", () => {
    expect(body).toMatch(
      /\/\/ Deep-link URL parser for `driftstack:\/\/` custom-scheme handoffs\./,
    );
    expect(body).toMatch(
      /\/\/ The Tauri shell registers `driftstack:\/\/` as a custom URL scheme so\s*\/\/ the browser can hand control back to the desktop app after a flow\s*\/\/ completes \(CLI authorization, recording load, profile import, etc\)\.\s*\/\/ `@tauri-apps\/plugin-deep-link\.onOpenUrl` fires whenever the OS\s*\/\/ dispatches one of these URLs to the running instance\./,
    );
  });

  it("Single-source framing pinned: 'This module is the typed, single-source parser every caller uses to turn the raw URL string into a discriminated payload. Each consumer (CLI auth flow, profile importer, recording loader) reads the `kind` discriminant and acts on the typed fields, instead of each caller hand-rolling URL parsing + string-matching.'", () => {
    expect(body).toMatch(
      /\/\/ This module is the typed, single-source parser every caller uses to\s*\/\/ turn the raw URL string into a discriminated payload\. Each consumer\s*\/\/ \(CLI auth flow, profile importer, recording loader\) reads the\s*\/\/ `kind` discriminant and acts on the typed fields, instead of each\s*\/\/ caller hand-rolling URL parsing \+ string-matching\./,
    );
  });

  it("Scheme shape framing pinned: 'driftstack://<host>/<path>?<query>' + 'host partitions the namespace; path partitions within the host.'", () => {
    expect(body).toMatch(/\/\/\s+driftstack:\/\/<host>\/<path>\?<query>/);
    expect(body).toMatch(
      /\/\/ `host` partitions the namespace; `path` partitions within the host\./,
    );
  });

  it("Forward-compat framing pinned: 'Unknown host/path combinations parse to { kind: unknown } and callers SHOULD ignore them — the OS may dispatch a URL the running app version doesn't understand (forward-compat from a newer dashboard issuing a deep-link the older GUI installer doesn't know about yet).'", () => {
    expect(body).toMatch(
      /\/\/ Unknown host\/path combinations parse to `\{ kind: 'unknown' \}` and\s*\/\/ callers SHOULD ignore them — the OS may dispatch a URL the running\s*\/\/ app version doesn't understand \(forward-compat from a newer\s*\/\/ dashboard issuing a deep-link the older GUI installer doesn't know\s*\/\/ about yet\)\./,
    );
  });

  it('DeepLinkPayload 5-variant union: cli-authorize{code,state} + session-open{sessionId} + recording-open{recordingId} + profile-import{profileId} + unknown{host,pathname}', () => {
    expect(body).toMatch(
      /export type DeepLinkPayload =\s*\| \{ kind: 'cli-authorize'; code: string; state: string \}\s*\| \{ kind: 'session-open'; sessionId: string \}\s*\| \{ kind: 'recording-open'; recordingId: string \}\s*\| \{ kind: 'profile-import'; profileId: string \}\s*\| \{ kind: 'unknown'; host: string; pathname: string \};/,
    );
  });

  it("DeepLinkParseError reason 3-union ('malformed-url'|'wrong-scheme'|'missing-required-param') + rawUrl on every error; DeepLinkParseResult ok-discriminated; REQUIRED_SCHEME = 'driftstack:'", () => {
    expect(body).toMatch(
      /export interface DeepLinkParseError \{\s*reason: 'malformed-url' \| 'wrong-scheme' \| 'missing-required-param';\s*rawUrl: string;\s*\}/,
    );
    expect(body).toMatch(
      /export type DeepLinkParseResult =\s*\| \{ ok: true; payload: DeepLinkPayload \}\s*\| \{ ok: false; error: DeepLinkParseError \};/,
    );
    expect(body).toMatch(/const REQUIRED_SCHEME = 'driftstack:';/);
  });

  it("parseDeepLink: new URL(rawUrl) try/catch → 'malformed-url'; protocol !== REQUIRED_SCHEME → 'wrong-scheme'; auth/callback (code+state) + session/open (session_id) + recording/open (recording_id) + profile/import (profile_id) 4 branches with missing-required-param guards", () => {
    expect(body).toMatch(
      /export function parseDeepLink\(rawUrl: string\): DeepLinkParseResult \{\s*let parsed: URL;\s*try \{\s*parsed = new URL\(rawUrl\);\s*\} catch \{\s*return \{ ok: false, error: \{ reason: 'malformed-url', rawUrl \} \};\s*\}\s*if \(parsed\.protocol !== REQUIRED_SCHEME\) \{\s*return \{ ok: false, error: \{ reason: 'wrong-scheme', rawUrl \} \};\s*\}/,
    );
    expect(body).toMatch(
      /if \(host === 'auth' && pathname\.startsWith\('\/callback'\)\) \{\s*const code = params\.get\('code'\);\s*const state = params\.get\('state'\);\s*if \(code === null \|\| code\.length === 0 \|\| state === null \|\| state\.length === 0\) \{\s*return \{ ok: false, error: \{ reason: 'missing-required-param', rawUrl \} \};\s*\}\s*return \{ ok: true, payload: \{ kind: 'cli-authorize', code, state \} \};\s*\}/,
    );
    expect(body).toMatch(
      /if \(host === 'session' && pathname\.startsWith\('\/open'\)\) \{\s*const sessionId = params\.get\('session_id'\);/,
    );
    expect(body).toMatch(
      /if \(host === 'recording' && pathname\.startsWith\('\/open'\)\) \{\s*const recordingId = params\.get\('recording_id'\);/,
    );
    expect(body).toMatch(
      /if \(host === 'profile' && pathname\.startsWith\('\/import'\)\) \{\s*const profileId = params\.get\('profile_id'\);/,
    );
  });

  it("Unknown fallback at bottom: 'return { ok: true, payload: { kind: unknown, host, pathname } };' — note: still ok:true (NOT an error)", () => {
    expect(body).toMatch(
      /return \{ ok: true, payload: \{ kind: 'unknown', host, pathname \} \};\s*\}/,
    );
  });

  it("dispatchDeepLink framing pinned: 'Errors and `unknown` payloads are silently dropped to keep the deep-link channel forward-compatible (a newer dashboard issuing an unknown deep-link kind doesn't make the GUI crash or show a noisy error toast).' + 4 optional router callbacks + 5-case switch dispatching each kind", () => {
    expect(body).toMatch(
      /Errors and `unknown` payloads are silently\s*\/\/ dropped to keep the deep-link channel forward-compatible \(a newer\s*\/\/ dashboard issuing an unknown deep-link kind doesn't make the GUI\s*\/\/ crash or show a noisy error toast\)\./,
    );
    expect(body).toMatch(
      /export function dispatchDeepLink\(\s*rawUrl: string,\s*router: Partial<\{\s*onCliAuthorize: \(code: string, state: string\) => void;\s*onSessionOpen: \(sessionId: string\) => void;\s*onRecordingOpen: \(recordingId: string\) => void;\s*onProfileImport: \(profileId: string\) => void;\s*\}>,\s*\): \{ dispatched: boolean; payload: DeepLinkPayload \| null \} \{/,
    );
    expect(body).toMatch(/case 'unknown':\s*return \{ dispatched: false, payload \};\s*\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
