// V-657-followup — drift guard for the status.driftstack.dev double-opt-in
// landing pages: /subscribe/confirm and /subscribe/unsubscribe. The
// confirmation email links to /subscribe/confirm/?token=, and every status
// email links to /subscribe/unsubscribe/?token= (see
// StatusSubscribersService confirmLink/unsubscribeLink). Pins:
//
//   • Both pages call the GET ?token= API contract (NOT a POST body) —
//     a POST body to these GET routes would 404. This is the same
//     spec-drift class the openapi.ts registration fix corrected.
//   • The server registers both as app.get(...).
//   • Pages read ?token= from the URL and handle 200 success + the
//     spec'd error statuses (400 expired/malformed, 404 invalid/used,
//     429 rate-limited).
//   • PUBLIC_API_BASE_URL fallback default (api.driftstack.dev).
//   • Stay no-framework inline-script pages (render when the control
//     plane / bundler is degraded) — same constraint as subscribe.astro.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CONFIRM_PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/subscribe/confirm.astro');
const UNSUB_PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/subscribe/unsubscribe.astro');
const SUBSCRIBERS_SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts');
const INCIDENT_NOTIFICATIONS = resolve(
  REPO_ROOT,
  'apps/server/src/services/incident-notifications.ts',
);
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Walk apps/server/src and return true if any .ts file matches `re`.
function serverMatches(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.name.endsWith('.ts')) {
        if (re.test(read(p))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

function hasSameEntryTokenScrub(source: string): boolean {
  return /const token = new URLSearchParams\(window\.location\.search\)\.get\('token'\);\s*if \(token\) \{\s*window\.history\.replaceState\([\s\S]*?window\.location\.pathname \+ window\.location\.hash/.test(
    source,
  );
}

function usesOnlyCanonicalTokenLinks(source: string): boolean {
  const matches = source.match(/\/subscribe\/(?:confirm|unsubscribe)\/?\?token=/g) ?? [];
  return matches.length > 0 && matches.every((value) => value.includes('/?token='));
}

describe('status-site /subscribe/confirm + /subscribe/unsubscribe parity', () => {
  const confirm = read(CONFIRM_PAGE);
  const unsub = read(UNSUB_PAGE);

  it('keeps both one-time token landing pages out of search indexes', () => {
    expect(confirm).toMatch(/<StatusLayout[^>]*\bnoindex\b/);
    expect(unsub).toMatch(/<StatusLayout[^>]*\bnoindex\b/);
  });

  it('confirm page calls GET /v1/status/subscribe/confirm with a ?token= query', () => {
    expect(confirm).toMatch(/\/v1\/status\/subscribe\/confirm\?token=/);
    expect(confirm).toMatch(/method:\s*['"]GET['"]/);
    // Negative: must NOT POST a JSON body to the GET route (the drift).
    expect(confirm).not.toMatch(/method:\s*['"]POST['"]/);
  });

  it('unsubscribe page calls GET /v1/status/subscribe/unsubscribe with a ?token= query', () => {
    expect(unsub).toMatch(/\/v1\/status\/subscribe\/unsubscribe\?token=/);
    expect(unsub).toMatch(/method:\s*['"]GET['"]/);
    expect(unsub).not.toMatch(/method:\s*['"]POST['"]/);
  });

  it('server registers both endpoints as GET (app.get)', () => {
    expect(serverMatches(/app\.get<[^>]*>\(\s*['"]\/v1\/status\/subscribe\/confirm['"]/)).toBe(
      true,
    );
    expect(serverMatches(/app\.get<[^>]*>\(\s*['"]\/v1\/status\/subscribe\/unsubscribe['"]/)).toBe(
      true,
    );
  });

  it('both pages read ?token= from the URL', () => {
    expect(confirm).toMatch(/URLSearchParams\(window\.location\.search\)\.get\(['"]token['"]\)/);
    expect(unsub).toMatch(/URLSearchParams\(window\.location\.search\)\.get\(['"]token['"]\)/);
  });

  it('both pages capture the token before replacing the same history entry', () => {
    for (const page of [confirm, unsub]) {
      expect(hasSameEntryTokenScrub(page)).toBe(true);
      expect(page.indexOf(".get('token');")).toBeLessThan(
        page.indexOf('window.history.replaceState('),
      );
      expect(page).not.toContain('window.history.pushState(');
      expect(page).not.toContain('window.location.reload(');
    }
  });

  it('rejects deletion of same-entry scrubbing and slash removal from generated bearer links', () => {
    expect(hasSameEntryTokenScrub(confirm.replace('window.history.replaceState(', ''))).toBe(false);
    expect(hasSameEntryTokenScrub(unsub.replace('window.history.replaceState(', ''))).toBe(false);

    for (const source of [read(SUBSCRIBERS_SERVICE), read(INCIDENT_NOTIFICATIONS)]) {
      expect(usesOnlyCanonicalTokenLinks(source)).toBe(true);
      expect(usesOnlyCanonicalTokenLinks(source.replaceAll('/?token=', '?token='))).toBe(false);
    }
  });

  it('confirm page handles 200 success + 400 / 404 / 429 errors', () => {
    expect(confirm).toMatch(/res\.status === 200/);
    expect(confirm).toMatch(/res\.status === 400/);
    expect(confirm).toMatch(/res\.status === 404/);
    expect(confirm).toMatch(/res\.status === 429/);
  });

  it('makes an ambiguous confirmation timeout terminal for the one-time link', () => {
    expect(confirm).toMatch(/id="confirm-unknown"/);
    expect(confirm).toMatch(/let confirmOutcomeUnknown = false/);
    expect(confirm).toMatch(/if \(confirmInFlight \|\| confirmOutcomeUnknown\) return/);
    expect(confirm).toMatch(/error && error\.name === 'AbortError'/);
    expect(confirm).toMatch(/confirmOutcomeUnknown = true/);
    expect(confirm).toMatch(/Do not reload or open this\s+confirmation link again/);
    expect(confirm).toMatch(/welcome\s+email with your unsubscribe link/);
  });

  it('unsubscribe page handles 200 success + 400 / 404 / 429 errors', () => {
    expect(unsub).toMatch(/res\.status === 200/);
    expect(unsub).toMatch(/res\.status === 400/);
    expect(unsub).toMatch(/res\.status === 404/);
    expect(unsub).toMatch(/res\.status === 429/);
  });

  it('uses fixed public copy instead of reflecting API diagnostics or bare statuses', () => {
    for (const page of [confirm, unsub]) {
      expect(page).not.toMatch(/body\.(?:detail|message)/);
      expect(page).not.toMatch(/HTTP \$\{res\.status\}/);
    }
    expect(confirm).toMatch(/Couldn't confirm your subscription right now/);
    expect(unsub).toMatch(/Couldn't unsubscribe you right now/);
  });

  it('makes an ambiguous unsubscribe timeout terminal for that link load', () => {
    expect(unsub).toMatch(/id="unsub-unknown"/);
    expect(unsub).toMatch(/let unsubscribeOutcomeUnknown = false/);
    expect(unsub).toMatch(/if \(unsubscribeInFlight \|\| unsubscribeOutcomeUnknown\) return/);
    expect(unsub).toMatch(/error && error\.name === 'AbortError'/);
    expect(unsub).toMatch(/unsubscribeOutcomeUnknown = true/);
    expect(unsub).toMatch(/Do not reload or open this unsubscribe link again/);
    expect(unsub).toMatch(/another status email arrives[\s\S]*newest email/);
  });

  it('both pages default PUBLIC_API_BASE_URL to api.driftstack.dev', () => {
    const fallback = /PUBLIC_API_BASE_URL\s*\?\?\s*['"]https:\/\/api\.driftstack\.dev['"]/;
    expect(confirm).toMatch(fallback);
    expect(unsub).toMatch(fallback);
  });

  it('both stay no-framework inline-script pages (render during control-plane outages)', () => {
    expect(confirm).toMatch(/<script is:inline/);
    expect(unsub).toMatch(/<script is:inline/);
    expect(confirm).not.toMatch(/client:load|client:idle|client:visible/);
    expect(unsub).not.toMatch(/client:load|client:idle|client:visible/);
  });

  it('confirm success copy hedges as double-opt-in (no marketing claim)', () => {
    expect(confirm).toMatch(/Subscription confirmed/);
    expect(confirm).toMatch(/never send marketing or promotional/i);
  });
});
