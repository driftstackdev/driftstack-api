// Drift guard for apps/customer-dashboard/src/pages/cli/authorize.
// astro. Pins the V-267 GUI-pairing flow + the V-266 backend
// route pairing + the "plaintext key never traverses this page"
// security invariant.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/cli/authorize.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard cli/authorize content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-267 + V-266 doc-comment framing pins the verified bind route pairing', () => {
    expect(body).toMatch(/\/\/ V-267 — Browser-OAuth confirmation page for the GUI client/);
    expect(body).toMatch(/paired with V-266 backend cli-authorize routes/);
    expect(body).toMatch(/POST \/v1\/auth\/cli-authorize\/bind-device-code/);
  });

  it("plaintext-key-never-traverses-page security invariant pinned: 'The plaintext key never traverses this page.' — drift would weaken the GUI-pairing security posture; the page only converts the code into a server-side mint, not into a plaintext-bearing response", () => {
    expect(body).toMatch(/The plaintext key never traverses this page\./);
  });

  it('ONLY-surface framing pinned: this page is the ONLY surface where a customer web session converts a CLI authorization code into a GUI-paired API key. Drift to a second conversion surface would split the security boundary', () => {
    expect(body).toMatch(/this page is the ONLY surface where a customer's web/);
    expect(body).toMatch(/session converts a CLI authorization code into a GUI-paired API key/);
  });

  it('5-step flow framing pinned: GUI opens URL → check session token → confirmation prompt → POST bind → success screen. Drift to skipping the session-check step would break customers who land here from the desktop app without an active web session', () => {
    expect(body).toMatch(/GUI opens this URL with `\?code=…&state=…` query params/);
    expect(body).toMatch(/Page checks localStorage\.ds_web_session_token/);
    expect(body).toMatch(/redirects to \/signup\?next=<this-url>/);
    expect(body).toMatch(/Page requires the separate verification code displayed only by/);
    expect(body).toMatch(/On Authorize: POST \/v1\/auth\/cli-authorize\/bind-device-code/);
  });

  it("withSidebar={false} on DashboardLayout — pinned so the GUI-pairing landing doesn't show the full nav, which would be confusing when arriving from the desktop client", () => {
    expect(body).toMatch(
      /<DashboardLayout title="Authorize desktop client" withSidebar=\{false\}>/,
    );
  });

  it("3-state UX state machine pinned: loading / missing / authorize-confirmation. Drift to a different state taxonomy would break the page's render-on-load + error-path semantics", () => {
    expect(body).toMatch(/data-state="loading"/);
    expect(body).toMatch(/data-state="missing"/);
  });
});
