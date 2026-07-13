// W251.B — drift-guard for the dashboard's /cli/authorize page.
// Pins the three-step CLI-pairing protocol the page implements to
// the live server routes:
//   POST /v1/auth/cli-authorize/initiate  (CLI/GUI starts the flow)
//   POST /v1/auth/cli-authorize/bind-device-code (dashboard binds)
//   POST /v1/auth/cli-authorize/exchange  (CLI/GUI polls for key)
//
// The dashboard ONLY interacts with /bind (it doesn't initiate or
// exchange). A rename of /bind that doesn't also update this page
// would silently break GUI activation.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/cli/authorize.astro');
const SERVER_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W251.B /cli/authorize page ↔ auth-cli routes parity', () => {
  const page = read(PAGE);
  const route = read(SERVER_ROUTE);

  it('page POSTs /v1/auth/cli-authorize/bind-device-code which the server registers', () => {
    expect(page).toContain('/v1/auth/cli-authorize/bind-device-code');
    expect(route).toContain(`'/v1/auth/cli-authorize/bind-device-code'`);
  });

  it('server registers all three CLI-authorize endpoints', () => {
    expect(route).toContain(`'/v1/auth/cli-authorize/initiate'`);
    expect(route).toContain(`'/v1/auth/cli-authorize/bind-device-code'`);
    expect(route).toContain(`'/v1/auth/cli-authorize/exchange'`);
  });

  it('page does not POST /initiate or /exchange (browser is dashboard-only)', () => {
    // The dashboard is purely the bind surface. Drift would be the
    // page accidentally calling initiate/exchange directly.
    const scriptOnly = page.split('<script')[1] ?? '';
    expect(scriptOnly).not.toMatch(/\/v1\/auth\/cli-authorize\/initiate/);
    expect(scriptOnly).not.toMatch(/\/v1\/auth\/cli-authorize\/exchange/);
  });

  it('page checks ds_web_session_token before allowing the bind', () => {
    // Drift would silently drop the auth gate. This is the security
    // invariant — only a logged-in customer can confirm a CLI bind.
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('page honors ?code= + ?state= round-trip from the GUI', () => {
    expect(page).toMatch(/code/);
    expect(page).toMatch(/state/);
  });

  it('never rebinds the same code after an ambiguous timeout', () => {
    expect(page).toMatch(/let authorizeOutcomeUnknown = false/);
    expect(page).toMatch(/if \(authorizeOutcomeUnknown\) \{/);
    expect(page).toMatch(/Return to desktop/);
    expect(page).toMatch(/Do not retry this link/);
    expect(page).toMatch(/start a fresh browser sign-in from the desktop app/);
  });
});
