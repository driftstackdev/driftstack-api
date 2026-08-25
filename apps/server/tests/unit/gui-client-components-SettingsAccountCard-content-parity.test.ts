// W477.B — drift guard for apps/gui-client/src/components/SettingsAccountCard.tsx.
// V-534.L account-info card. Drift here either drops the
// dashboardUrlFor mapping (the 'Manage billing' link points at
// the wrong host — local dev redirects users to prod app, or
// prod app redirects them to localhost:5173 which they don't
// have) or breaks the effect-owned abort/body-disposal boundary
// (a fast unmount sets state on an unmounted component, or an
// ignored response keeps its connection body unread).
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
//   • effect-owned abort + unread-response disposal in useEffect.
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
      /\/\/ Shows the connected account id \(read from \/v1\/account\/me\) plus a\s*\/\/ "Manage billing" link that opens the dashboard's billing page\.\s*\/\/ Stays a separate component so SettingsView's existing tests \(V-272\)\s*\/\/ don't churn — parent decides whether to mount it\./,
    );
    expect(body).toMatch(
      /\/\/ The card has three observable states:\s*\/\/\s+- loading: account fetch in-flight\s*\/\/\s+- error: 401 \/ 403 \/ network — the card collapses to a small notice\s*\/\/\s+with plain-language guidance and a Retry button\s*\/\/\s+- ready: account id \+ tier rendered, billing link visible/,
    );
  });

  it("AccountMeResponse {account:{id+email+tier}} 3-field + CardState 3-variant (loading | error{message} | ready{account: AccountMeResponse['account']})", () => {
    expect(body).toMatch(
      // ⛔ V-1611 — this pinned the NESTED `{ account: { … } }` shape, which is
      // the defect, not the contract: the route has only ever sent a flat body.
      // The guard was holding the bug in place, and because the file it reads
      // had already been corrected, it could no longer match — which is how it
      // came to hang rather than fail. Now pins the shape the server sends.
      /interface AccountMeResponse \{\s*id: string;\s*email: string;\s*tier: string;\s*\}/,
    );
    expect(body).toMatch(
      /type CardState =\s*\| \{ kind: 'loading' \}\s*\| \{ kind: 'error'; message: string \}\s*\| \{ kind: 'ready'; account: AccountMeResponse \};/,
    );
  });

  it("dashboardUrlFor mapping: localhost OR driftstack.local → http://localhost:5173 (dev dashboard); otherwise https://app.driftstack.dev — pinned so the 'Manage billing' link doesn't redirect prod users to a localhost dev port or vice-versa; JSDoc framing 'mapping lives here (and not in SettingsContext) so the card is the single place that has to change when the dashboard moves'", () => {
    expect(body).toMatch(
      /\* Resolve the dashboard URL for the configured baseUrl\. The mapping\s*\*\s+lives here \(and not in SettingsContext\) so the card is the single\s*\*\s+place that has to change when the dashboard moves\./,
    );
    expect(body).toMatch(
      /function dashboardUrlFor\(baseUrl: string\): string \{\s*\/\/ localhost \/ app\.driftstack\.local → use the dev dashboard\.\s*if \(baseUrl\.includes\('localhost'\) \|\| baseUrl\.includes\('driftstack\.local'\)\) \{\s*return 'http:\/\/localhost:5173';\s*\}\s*return 'https:\/\/app\.driftstack\.dev';\s*\}/,
    );
  });

  it('Effect: !settings.apiKey → actionable error; shared deadline with effect-owned abort; baseUrl trim + /v1/account/me Bearer/JSON; plain-English HTTP errors; abort guards before state writes; cleanup aborts; retryNonce re-runs fetch', () => {
    expect(body).toMatch(
      /if \(!settings\.apiKey\) \{\s*setState\(\{ kind: 'error', message: 'No API key configured\.' \}\);\s*return;\s*\}\s*setState\(\{ kind: 'loading' \}\);\s*const controller = new AbortController\(\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(`\$\{baseUrl\}\/v1\/account\/me`, \{\s*signal: controller\.signal,\s*headers: \{ authorization: `Bearer \$\{settings\.apiKey \?\? ''\}`, accept: 'application\/json' \},\s*\}\);\s*if \(controller\.signal\.aborted\) \{\s*await disposeResponseBody\(res\);\s*return;\s*\}\s*if \(!res\.ok\) \{\s*const status = res\.status;\s*await disposeResponseBody\(res\);\s*setState\(\{ kind: 'error', message: errorMessageForStatus\(status\) \}\);\s*return;\s*\}\s*const body = await readBoundedApiJson<AccountMeResponse>\(res\);\s*if \(controller\.signal\.aborted\) return;\s*setState\(\{ kind: 'ready', account: body \}\);/,
    );
    expect(body).toMatch(
      /return \(\) => \{\s*controller\.abort\(\);\s*\};\s*\}, \[settings\.apiKey, settings\.baseUrl, retryNonce\]\);/,
    );
    // errorMessageForStatus maps 401/403/other into actionable copy — no bare "HTTP 401".
    expect(body).toMatch(
      /function errorMessageForStatus\(status: number\): string \{\s*if \(status === 401\) return "Your API key wasn't accepted\. Check the key above, then retry\.";\s*if \(status === 403\) return "This API key doesn't have access to account info\.";\s*if \(status === 404\) return 'Account info is not available for this key\.';\s*if \(status === 429\) return 'Too many requests\. Wait a moment, then retry\.';\s*if \(status >= 500\) return 'The account service is temporarily unavailable\. Try again shortly\.';\s*return "Couldn't load account info\. Check the server URL, then retry\.";\s*\}/,
    );
  });

  it("Render: <section aria-label='Account info'> (Panel-idiom rounded-xl shadow-sm) + 'Manage billing →' anchor with canonical `${dashboardUrl}/billing/` href + target='_blank' + rel='noreferrer'; loading state role='status'; error state is now a role='alert' <div> with the mapped {state.message} + a Retry button (bumps retryNonce); ready state dl with a click-to-copy Account id <button title='Copy account id'> + Email + humanizeTier(tier) rows", () => {
    expect(body).toMatch(
      /<section\s*aria-label="Account info"\s*className="rounded-xl border border-surface-divider bg-surface-raised px-5 py-4 shadow-sm space-y-2"\s*>/,
    );
    expect(body).toMatch(
      /<a\s*href=\{`\$\{dashboardUrl\}\/billing\/`\}\s*target="_blank"\s*rel="noreferrer"\s*className="text-sm text-accent underline"\s*>\s*Manage billing →\s*<\/a>/,
    );
    expect(body).toMatch(
      /\{state\.kind === 'loading' && \(\s*<p className="text-sm text-ink-secondary" role="status">\s*Loading account…\s*<\/p>\s*\)\}/,
    );
    // Error state: a role='alert' DIV holding the mapped message + a Retry button.
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*<div className="flex items-start justify-between gap-3" role="alert">\s*<p className="text-sm text-status-warning">\{state\.message\}<\/p>\s*<button\s*type="button"\s*className="btn-secondary shrink-0"\s*onClick=\{\(\) => setRetryNonce\(\(n\) => n \+ 1\)\}\s*>\s*Retry\s*<\/button>/,
    );
    // Account id is a click-to-copy button (calls handleCopyId), not a bare <dd>.
    expect(body).toMatch(
      /<button\s*type="button"\s*onClick=\{\(\) => void handleCopyId\(state\.account\.id\)\}\s*title="Copy account id"[\s\S]*?>\s*\{state\.account\.id\}\s*<\/button>/,
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
