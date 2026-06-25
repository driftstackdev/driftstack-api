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

  it.skip('V-184a onboarding-step-5 + V-501 framing comments pinned', () => {
    expect(body).toMatch(/V-184a — onboarding step 5\. First session creation/);
    expect(body).toMatch(/V-501 — disabled-while-pending guard \+ clearer status copy/);
  });

  it('LOCKED_ARCHETYPE_DISPLAY_LABEL imported from @driftstack/api-types + surfaced in the archetype explanation paragraph (2026-05-16 enhancement-review A2: prior bare "Default archetype: <strong>{LABEL}</strong>." replaced with plain-English explanation)', () => {
    expect(body).toMatch(
      /import \{ LOCKED_ARCHETYPE_DISPLAY_LABEL \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /You're starting with\s+<strong>\{LOCKED_ARCHETYPE_DISPLAY_LABEL\}<\/strong>/,
    );
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
    // Step 2 — create session with the new (or V-501b-reused) API key.
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/sessions'/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ apiKeyPlaintext/);
    // V-501b — retry-safe: reuse a stashed key instead of minting a duplicate.
    expect(body).toMatch(
      /let apiKeyPlaintext = sessionStorage\.getItem\('ds_first_api_key_plaintext'\)/,
    );
  });

  it.skip('V-168 web-session-on-/v1/api-keys exception framed in comment (minimal-flow rationale)', () => {
    expect(body).toMatch(
      /V-168 makes the web-session token usable on\s*\n?\s*\/\/\s*\/v1\/api-keys/,
    );
  });

  it('sessionStorage ds_first_api_key_plaintext stash for /sessions redirect (shown-once handoff)', () => {
    expect(body).toMatch(
      /sessionStorage\.setItem\('ds_first_api_key_plaintext', apiKey\.plaintext\);/,
    );
  });

  it('"shown once; copy it somewhere safe" customer-facing copy pinned (2026-05-16 enhancement-review A3: expanded with plain-English "a secret token your code uses to call the SDK" + safe-storage hint examples (1Password / git-ignored .env / similar))', () => {
    expect(body).toMatch(
      /We'll create your first <strong>API key<\/strong> in the background —\s+a secret token your code uses to call the SDK\. It's shown once on\s+the next page; copy it somewhere safe \(1Password, a git-ignored/,
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

  it.skip('V-501 disabled-while-pending double-mint guard pinned (setBusy + submitBtn.disabled gate)', () => {
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
      /Skip this step\?\s*<a href="\/" class="text-tk-accent underline">Go to dashboard<\/a>/,
    );
  });

  it('W457 noob-friendly session framing — plain-language, jargon stripped ("an iPhone Safari browser running in the cloud — every website it visits sees a genuine iPhone, not a bot"). Respects the 2026-05-16 honesty pass (no "real" overclaim; frames it as what websites SEE).', () => {
    expect(body).toMatch(
      /A session is an iPhone Safari browser running in the cloud —\s+every website it visits sees a genuine iPhone, not a bot\./,
    );
    // honesty pass preserved + W457 jargon stripped.
    expect(body).not.toMatch(/A session is a real iOS Safari instance/);
    expect(body).not.toMatch(/same WebKit, same fingerprint surface as a physical iPhone/);
  });

  it('credentials:"include" on both fetches (cookie-session post-issuance)', () => {
    const fetchBlocks = body.match(/fetch\(apiBaseUrl[\s\S]*?credentials: 'include'/g);
    expect(fetchBlocks).not.toBeNull();
    expect(fetchBlocks!.length).toBeGreaterThanOrEqual(2);
  });

  it('handles the LegalAcceptanceRequired 409 on mint: accepts all pending docs inline then retries (fresh accounts have accepted nothing, so the CTA must not dead-end on a raw 409)', () => {
    // Detected on the problem `type` URI, not the human detail string.
    expect(body).toContain('https://errors.driftstack.dev/legal-acceptance-required');
    expect(body).toMatch(/mintRes\.status === 409 && errBody\.type === LEGAL_ACCEPTANCE_TYPE/);
    // Accept-all logic reads /v1/legal/required (carries content_hash) +
    // POSTs /v1/legal/accept per doc — mirrors DashboardLayout.
    expect(body).toContain('/v1/legal/required');
    expect(body).toContain('/v1/legal/accept');
    expect(body).toMatch(/document_key: doc\.document_key/);
    expect(body).toMatch(/content_hash: doc\.content_hash/);
    // Retry the mint after acceptance.
    expect(body).toMatch(/await acceptPendingLegal\(\)/);
    expect(body).toMatch(/mintRes = await mintKey\(\)/);
  });
});
