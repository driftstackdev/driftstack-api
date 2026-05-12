// W373.B — drift guard for customer-dashboard /first-session page
// content. V-184a + V-168 + V-501. Existing first-session-page-
// parity + first-session-page-endpoints-parity tests cover route
// + endpoint wiring. This guard pins the load-bearing flow
// claims for the onboarding-step-5 surface:
//
//   • V-184a onboarding-step-5 framing comment pinned + V-501
//     disabled-while-pending double-mint guard.
//   • LOCKED_ARCHETYPE_DISPLAY_LABEL imported from @driftstack/
//     api-types (default-archetype copy stays aligned with the
//     schema's source of truth).
//   • 2-step flow pinned: (1) mint default API key with web-
//     session Bearer (V-168 web-session-on-/v1/api-keys
//     exception), (2) use that key to POST /v1/sessions.
//   • Key minted with scopes:['read','write'] + name:'default'.
//   • sessionStorage ds_first_api_key_plaintext stash (so the
//     /sessions redirect can show the "shown once" plaintext).
//   • "shown once; copy it somewhere safe" customer-facing copy.
//   • Defensive redirect to /signup when no ds_web_session_token.
//   • Success redirect to /sessions?onboarded=1.
//   • Label input maxlength=120 + required.
//   • V-501 disabled-while-pending double-mint guard.
//   • withSidebar={false} pre-tier-selection layout.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_DISPLAY_LABEL } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/first-session.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W373.B customer-dashboard /first-session page content parity', () => {
  const body = read(PAGE);

  it('V-184a onboarding-step-5 + V-501 framing comments pinned', () => {
    expect(body).toMatch(/V-184a — onboarding step 5\. First session creation/);
    expect(body).toMatch(/V-501 — disabled-while-pending guard \+ clearer status copy/);
  });

  it('LOCKED_ARCHETYPE_DISPLAY_LABEL imported from @driftstack/api-types (schema-aligned default)', () => {
    expect(body).toMatch(
      /import \{ LOCKED_ARCHETYPE_DISPLAY_LABEL \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/Default archetype: <strong>\{LOCKED_ARCHETYPE_DISPLAY_LABEL\}<\/strong>/);
    // The label imported must be non-empty (sanity check that the
    // schema source-of-truth resolves).
    expect(typeof LOCKED_ARCHETYPE_DISPLAY_LABEL).toBe('string');
    expect(LOCKED_ARCHETYPE_DISPLAY_LABEL.length).toBeGreaterThan(0);
  });

  it('2-step flow pinned: mint API key via web-session → create session via API key', () => {
    // Step 1 — mint with web-session Bearer + default name + scopes:['read','write'].
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/api-keys'/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ token/);
    expect(body).toMatch(/JSON\.stringify\(\{ name: 'default', scopes: \['read', 'write'\] \}\)/);
    // Step 2 — create session with the new API key plaintext.
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/sessions'/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ apiKey\.plaintext/);
  });

  it('V-168 web-session-on-/v1/api-keys exception framed in comment (minimal-flow rationale)', () => {
    expect(body).toMatch(
      /V-168 makes the web-session token usable on\s*\n?\s*\/\/\s*\/v1\/api-keys/,
    );
  });

  it('sessionStorage ds_first_api_key_plaintext stash for /sessions redirect (shown-once handoff)', () => {
    expect(body).toMatch(
      /sessionStorage\.setItem\('ds_first_api_key_plaintext', apiKey\.plaintext\);/,
    );
  });

  it('"shown once; copy it somewhere safe" customer-facing copy pinned', () => {
    expect(body).toMatch(
      /We'll mint your first API key in the background — you'll see it on\s+the next page\. The key is shown once; copy it somewhere safe\./,
    );
  });

  it('defensive redirect to /signup when no ds_web_session_token (no orphan landings)', () => {
    expect(body).toMatch(/if \(!token\) \{\s*\n?\s*window\.location\.replace\('\/signup'\);/);
  });

  it('success redirect to /sessions?onboarded=1 (onboarded-flag for downstream UX)', () => {
    expect(body).toMatch(/window\.location\.href = '\/sessions\?onboarded=1'/);
  });

  it('label input required + maxlength=120 + placeholder "my-first-session"', () => {
    expect(body).toMatch(/<input[^>]*id="session-label"[\s\S]*?required/);
    expect(body).toMatch(/<input[^>]*id="session-label"[\s\S]*?maxlength="120"/);
    expect(body).toMatch(/placeholder="my-first-session"/);
  });

  it('V-501 disabled-while-pending double-mint guard pinned (setBusy + submitBtn.disabled gate)', () => {
    expect(body).toMatch(/V-501 — guard against double-mint/);
    expect(body).toMatch(/if \(submitBtn\.disabled\) return;/);
    expect(body).toMatch(/setBusy\(true\)/);
    // Busy + default labels toggle.
    expect(body).toMatch(/<span data-label-default>Create session<\/span>/);
    expect(body).toMatch(/<span data-label-busy class="hidden">Creating…<\/span>/);
  });

  it('withSidebar={false} pre-tier-selection layout', () => {
    expect(body).toMatch(/<DashboardLayout title="First session" withSidebar=\{false\}/);
  });

  it('"Skip this step" escape hatch points at root /', () => {
    expect(body).toMatch(
      /Skip this step\?\s*<a href="\/" class="text-oxblood-700 underline">Go to dashboard<\/a>/,
    );
  });

  it('"real iOS Safari instance" + "same WebKit, same fingerprint surface" framing pinned', () => {
    expect(body).toMatch(
      /A session is a real iOS Safari instance running on Driftstack's\s+fleet — same WebKit, same fingerprint surface as a physical iPhone\./,
    );
  });

  it('credentials:"include" on both fetches (cookie-session post-issuance)', () => {
    const fetchBlocks = body.match(/fetch\(apiBaseUrl[\s\S]*?credentials: 'include'/g);
    expect(fetchBlocks).not.toBeNull();
    expect(fetchBlocks!.length).toBeGreaterThanOrEqual(2);
  });
});
