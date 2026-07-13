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
      /\/\/ The card has three observable states:\s*\n?\s*\/\/\s+- loading: account fetch in-flight\s*\n?\s*\/\/\s+- error: 401 \/ 403 \/ network — the card collapses to a small notice\s*\n?\s*\/\/\s+with plain-language guidance and a Retry button\s*\n?\s*\/\/\s+- ready: account id \+ tier rendered, billing link visible/,
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

  it('Effect: !settings.apiKey → actionable error; shared deadline with effect-owned abort; baseUrl trim + /v1/account/me Bearer/JSON; plain-English HTTP errors; abort guards before state writes; cleanup aborts; retryNonce re-runs fetch', () => {
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{ kind: 'error', message: 'No API key configured\.' \}\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*setState\(\{ kind: 'loading' \}\);\s*\n?\s*const controller = new AbortController\(\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/account\/me`, \{\s*\n?\s*signal: controller\.signal,\s*\n?\s*headers: \{ authorization: `Bearer \$\{settings\.apiKey \?\? ''\}`, accept: 'application\/json' \},\s*\n?\s*\}\);\s*\n?\s*if \(controller\.signal\.aborted\) return;\s*\n?\s*if \(!res\.ok\) \{\s*\n?\s*setState\(\{ kind: 'error', message: errorMessageForStatus\(res\.status\) \}\);/,
    );
    expect(body).toMatch(
      /return \(\) => \{\s*\n?\s*controller\.abort\(\);\s*\n?\s*\};\s*\n?\s*\}, \[settings\.apiKey, settings\.baseUrl, retryNonce\]\);/,
    );
    // errorMessageForStatus maps 401/403/other into actionable copy — no bare "HTTP 401".
    expect(body).toMatch(
      /function errorMessageForStatus\(status: number\): string \{\s*\n?\s*if \(status === 401\) return "Your API key wasn't accepted\. Check the key above, then retry\.";\s*\n?\s*if \(status === 403\) return "This API key doesn't have access to account info\.";\s*\n?\s*return `Couldn't load account info \(HTTP \$\{status\.toString\(\)\}\)\.`;\s*\n?\s*\}/,
    );
  });

  it("Render: <section aria-label='Account info'> (Panel-idiom rounded-xl shadow-sm) + 'Manage billing →' anchor with `${dashboardUrl}/billing` href + target='_blank' + rel='noreferrer'; loading state role='status'; error state is now a role='alert' <div> with the mapped {state.message} + a Retry button (bumps retryNonce); ready state dl with a click-to-copy Account id <button title='Copy account id'> + Email + humanizeTier(tier) rows", () => {
    expect(body).toMatch(
      /<section\s*\n?\s*aria-label="Account info"\s*\n?\s*className="rounded-xl border border-surface-divider bg-surface-raised px-5 py-4 shadow-sm space-y-2"\s*\n?\s*>/,
    );
    expect(body).toMatch(
      /<a\s*\n?\s*href=\{`\$\{dashboardUrl\}\/billing`\}\s*\n?\s*target="_blank"\s*\n?\s*rel="noreferrer"\s*\n?\s*className="text-sm text-accent underline"\s*\n?\s*>\s*\n?\s*Manage billing →\s*\n?\s*<\/a>/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'loading' && \(\s*\n?\s*<p className="text-sm text-ink-secondary" role="status">\s*\n?\s*Loading account…\s*\n?\s*<\/p>\s*\n?\s*\)\}/,
    );
    // Error state: a role='alert' DIV holding the mapped message + a Retry button.
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*\n?\s*<div className="flex items-start justify-between gap-3" role="alert">\s*\n?\s*<p className="text-sm text-status-warning">\{state\.message\}<\/p>\s*\n?\s*<button\s*\n?\s*type="button"\s*\n?\s*className="btn-secondary shrink-0"\s*\n?\s*onClick=\{\(\) => setRetryNonce\(\(n\) => n \+ 1\)\}\s*\n?\s*>\s*\n?\s*Retry\s*\n?\s*<\/button>/,
    );
    // Account id is a click-to-copy button (calls handleCopyId), not a bare <dd>.
    expect(body).toMatch(
      /<button\s*\n?\s*type="button"\s*\n?\s*onClick=\{\(\) => void handleCopyId\(state\.account\.id\)\}\s*\n?\s*title="Copy account id"[\s\S]*?>\s*\n?\s*\{state\.account\.id\}\s*\n?\s*<\/button>/,
    );
    // Tier is humanized (slug → Title Case) before display.
    expect(body).toMatch(
      /<dd className="text-ink-primary">\{humanizeTier\(state\.account\.tier\)\}<\/dd>/,
    );
    // humanizeTier turns a 'self_hosted'/'pay-as-you-go' slug into a human label.
    expect(body).toMatch(/function humanizeTier\(tier: string\): string \{/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
