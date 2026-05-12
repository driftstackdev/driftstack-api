// W477.B — drift guard for apps/gui-client/src/components/SettingsAccountCard.tsx.
// V-534.L account-info card. Drift here either drops the
// dashboardUrlFor mapping (the 'Manage billing' link points at
// the wrong host — local dev redirects users to prod app, or
// prod app redirects them to localhost:5173 which they don't
// have) or breaks the cancelled-flag cleanup (a fast unmount
// during an in-flight fetch sets state on an unmounted
// component and React logs the dev warning).
//
//   • V-534.L framing pinned: 'account-info card surfaced in
//     SettingsView.' + 'Shows the connected account id (read
//     from /v1/account/me) plus a "Manage billing" link that
//     opens the dashboard's billing page. Stays a separate
//     component so SettingsView's existing tests (V-272) don't
//     churn — parent decides whether to mount it.'
//   • 3-state framing: 'loading: account fetch in-flight' +
//     'error: 401 / 403 / network — the card collapses to a
//     small notice' + 'ready: account id + tier rendered,
//     billing link visible'.
//   • CardState 3-variant (loading | error{message} |
//     ready{account}); AccountMeResponse {account:{id+email+tier}}.
//   • dashboardUrlFor: localhost / driftstack.local →
//     http://localhost:5173, otherwise https://app.driftstack.dev.
//   • cancelled-flag cleanup pattern in useEffect.
//   • Render: <section aria-label='Account info'> + 'Manage
//     billing →' anchor + dt/dd dl on ready state.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/SettingsAccountCard.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W477.B apps/gui-client/src/components/SettingsAccountCard.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.L framing pinned: 'V-534.L — account-info card surfaced in SettingsView.' + 'Shows the connected account id (read from /v1/account/me) plus a \"Manage billing\" link that opens the dashboard's billing page. Stays a separate component so SettingsView's existing tests (V-272) don't churn — parent decides whether to mount it.' + 3-state framing 'loading / error / ready'", () => {
    expect(body).toMatch(/\/\/ V-534\.L — account-info card surfaced in SettingsView\./);
    expect(body).toMatch(
      /\/\/ Shows the connected account id \(read from \/v1\/account\/me\) plus a\s*\n?\s*\/\/ "Manage billing" link that opens the dashboard's billing page\.\s*\n?\s*\/\/ Stays a separate component so SettingsView's existing tests \(V-272\)\s*\n?\s*\/\/ don't churn — parent decides whether to mount it\./,
    );
    expect(body).toMatch(
      /\/\/ The card has three observable states:\s*\n?\s*\/\/\s+- loading: account fetch in-flight\s*\n?\s*\/\/\s+- error: 401 \/ 403 \/ network — the card collapses to a small notice\s*\n?\s*\/\/\s+- ready: account id \+ tier rendered, billing link visible/,
    );
  });

  it("AccountMeResponse {account:{id+email+tier}} 3-field + CardState 3-variant (loading | error{message} | ready{account: AccountMeResponse['account']})", () => {
    expect(body).toMatch(
      /interface AccountMeResponse \{\s*\n?\s*account: \{\s*\n?\s*id: string;\s*\n?\s*email: string;\s*\n?\s*tier: string;\s*\n?\s*\};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /type CardState =\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'error'; message: string \}\s*\n?\s*\| \{ kind: 'ready'; account: AccountMeResponse\['account'\] \};/,
    );
  });

  it("dashboardUrlFor mapping: localhost OR driftstack.local → http://localhost:5173 (dev dashboard); otherwise https://app.driftstack.dev — pinned so the 'Manage billing' link doesn't redirect prod users to a localhost dev port or vice-versa; JSDoc framing 'mapping lives here (and not in SettingsContext) so the card is the single place that has to change when the dashboard moves'", () => {
    expect(body).toMatch(
      /\* Resolve the dashboard URL for the configured baseUrl\. The mapping\s*\n?\s*\*\s+lives here \(and not in SettingsContext\) so the card is the single\s*\n?\s*\*\s+place that has to change when the dashboard moves\./,
    );
    expect(body).toMatch(
      /function dashboardUrlFor\(baseUrl: string\): string \{\s*\n?\s*\/\/ localhost \/ app\.driftstack\.local → use the dev dashboard\.\s*\n?\s*if \(baseUrl\.includes\('localhost'\) \|\| baseUrl\.includes\('driftstack\.local'\)\) \{\s*\n?\s*return 'http:\/\/localhost:5173';\s*\n?\s*\}\s*\n?\s*return 'https:\/\/app\.driftstack\.dev';\s*\n?\s*\}/,
    );
  });

  it("Effect: !settings.apiKey → setState error 'No API key configured.' early return; cancelled flag captures unmount; baseUrl trim trailing slashes + /v1/account/me GET with Bearer auth + 'application/json' Accept; !res.ok → 'HTTP ${status}' fallback; cancelled-check before each setState (no setState on unmounted component); cleanup returns () => { cancelled = true; }", () => {
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{ kind: 'error', message: 'No API key configured\.' \}\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*let cancelled = false;/,
    );
    expect(body).toMatch(
      /const res = await fetch\(`\$\{baseUrl\}\/v1\/account\/me`, \{\s*\n?\s*headers: \{ authorization: `Bearer \$\{settings\.apiKey \?\? ''\}`, accept: 'application\/json' \},\s*\n?\s*\}\);\s*\n?\s*if \(cancelled\) return;\s*\n?\s*if \(!res\.ok\) \{\s*\n?\s*setState\(\{ kind: 'error', message: `HTTP \$\{res\.status\.toString\(\)\}` \}\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /return \(\) => \{\s*\n?\s*cancelled = true;\s*\n?\s*\};\s*\n?\s*\}, \[settings\.apiKey, settings\.baseUrl\]\);/,
    );
  });

  it("Render: <section aria-label='Account info'> + 'Manage billing →' anchor with `${dashboardUrl}/billing` href + target='_blank' + rel='noreferrer'; loading state role='status' + error state role='alert' + ready state dl with Account id (font-mono) + Email + Tier rows", () => {
    expect(body).toMatch(
      /<section\s*\n?\s*aria-label="Account info"\s*\n?\s*className="max-w-xl rounded border border-surface-divider bg-surface-raised px-4 py-3 space-y-2"\s*\n?\s*>/,
    );
    expect(body).toMatch(
      /<a\s*\n?\s*href=\{`\$\{dashboardUrl\}\/billing`\}\s*\n?\s*target="_blank"\s*\n?\s*rel="noreferrer"\s*\n?\s*className="text-sm text-accent underline"\s*\n?\s*>\s*\n?\s*Manage billing →\s*\n?\s*<\/a>/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'loading' && \(\s*\n?\s*<p className="text-sm text-ink-secondary" role="status">\s*\n?\s*Loading account…\s*\n?\s*<\/p>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*\n?\s*<p className="text-sm text-status-warning" role="alert">\s*\n?\s*\{state\.message\}\s*\n?\s*<\/p>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(/<dd className="font-mono text-ink-primary">\{state\.account\.id\}<\/dd>/);
    expect(body).toMatch(/<dd className="text-ink-primary">\{state\.account\.tier\}<\/dd>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
