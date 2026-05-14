// W741 — customer-dashboard first-session.astro V-184a step 5 +
// V-501 parity. Sixty-seventh in the cross-SDK drift-guard series.
//
// The first-session page is the V-184a onboarding step 5 — runs the
// 2-step mint-key-then-create-session flow that gives the customer
// their first session + first plaintext API key.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/first-session.astro');

describe('W741 dashboard first-session V-184a + V-501 parity', () => {
  it('first-session.astro file exists at the canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-184a onboarding-step-5 anchor + V-184b Tier-3 deferral framing pinned. The page is Tier 1 minimal placeholder; full UX (tutorial, embedded WebView, view-your-first-capture CTA) lands in V-184b.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-184a — onboarding step 5\. First session creation\. Tier 1 minimal/);
    expect(p).toMatch(
      /placeholder — full Tier 3 visual UX \(tutorial, embedded WebView,\s*\n\/\/\s+"view your first capture" CTA\) lands in V-184b draft/,
    );
  });

  it('CRITICAL V-501 disabled-while-pending guard pinned. The setBusy() toggle disables the submit button + swaps label between "Create session" and "Creating…". Drift to dropping would let double-clicks mint 2 API keys + 2 sessions.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-501 — disabled-while-pending guard \+ clearer status copy/);

    // setBusy implementation.
    expect(p).toMatch(
      /function setBusy\(busy\) \{\s*\n\s+submitBtn\.disabled = busy;\s*\n\s+labelDefault\.classList\.toggle\('hidden', busy\);\s*\n\s+labelBusy\.classList\.toggle\('hidden', !busy\)/,
    );

    // Double-mint guard.
    expect(p).toMatch(/if \(submitBtn\.disabled\) return; \/\/ — guard against double-mint/);
  });

  it('CRITICAL LOCKED_ARCHETYPE_DISPLAY_LABEL api-types import pinned. The locked-archetype display name comes from api-types (single source of truth) — drift to inlining would let dashboard show a different label than what the SDK + marketing claim.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ LOCKED_ARCHETYPE_DISPLAY_LABEL \} from '@driftstack\/api-types'/);
    expect(p).toMatch(/Default archetype: <strong>\{LOCKED_ARCHETYPE_DISPLAY_LABEL\}<\/strong>/);
  });

  it('CRITICAL \'real iOS Safari instance\' canonical product claim pinned. The wording — "same WebKit, same fingerprint surface as a physical iPhone" — matches W739 welcome.astro + marketing site canonical positioning.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /A session is a real iOS Safari instance running on Driftstack's\s*\n\s+fleet — same WebKit, same fingerprint surface as a physical iPhone/,
    );
  });

  it('CRITICAL plaintext-once framing pinned for the auto-minted API key. The wording — "The key is shown once; copy it somewhere safe" — matches W701 + W707 plaintext-once invariant.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /We'll mint your first API key in the background — you'll see it on\s*\n\s+the next page\. The key is shown once; copy it somewhere safe/,
    );
  });

  it('CRITICAL 2-step flow doc-block pinned — 1. Mint default API key via web session. 2. Use that key to create session. 3. Stash plaintext in sessionStorage for /api-keys post-onboarding view. Drift would break the V-184a flow into /api-keys.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. Mint a "default" API key via web session/);
    expect(p).toMatch(/2\. Use that API key to create the session/);
    expect(p).toMatch(
      /3\. Stash the new API key plaintext in sessionStorage so the\s*\n\s+\/\/\s+\/first-session redirect to \/sessions can show it/,
    );
  });

  it("CRITICAL Step 1: POST /v1/api-keys contract pinned. Body {name:'default', scopes:['read','write']}; auth via Bearer web-session-token. The 2-scope mint is what gives the first session enough power without admin-scope. Drift to admin would let leaked key mint more keys.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/api-keys', \{\s*\n\s+method: 'POST',\s*\n\s+headers: \{ 'content-type': 'application\/json', authorization: 'Bearer ' \+ token \},\s*\n\s+credentials: 'include',\s*\n\s+body: JSON\.stringify\(\{ name: 'default', scopes: \['read', 'write'\] \}\)/,
    );
  });

  it('CRITICAL ds_first_api_key_plaintext sessionStorage handoff pinned. The plaintext stash is what lets /api-keys post-onboarding view show the once-only key. Drift to localStorage would persist across browser-tabs (worse for the once-shown invariant); drift to dropping would force a re-mint.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/sessionStorage\.setItem\('ds_first_api_key_plaintext', apiKey\.plaintext\)/);
  });

  it("CRITICAL Step 2: POST /v1/sessions contract uses the JUST-MINTED API key (NOT the web-session-token). Auth header is 'Bearer ' + apiKey.plaintext. The api-key-auth choice is what proves the key works end-to-end before the customer sees it. Drift to web-session auth on session-create would skip the verify-the-key step.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/sessions', \{\s*\n\s+method: 'POST',\s*\n\s+headers: \{ 'content-type': 'application\/json', authorization: 'Bearer ' \+ apiKey\.plaintext \},\s*\n\s+credentials: 'include',\s*\n\s+body: JSON\.stringify\(\{ label \}\)/,
    );
  });

  it('CRITICAL Success redirect to /sessions?onboarded=1. The ?onboarded=1 query flag is what triggers the /sessions view to show the post-onboarding banner + auto-display the first API key. Drift to dropping would lose the onboarding completion signal.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/window\.location\.href = '\/sessions\?onboarded=1'/);
  });

  it('CRITICAL defensive redirect to /signup when no ds_web_session_token. Drift would let unauthenticated users hit /first-session + see a confusing error.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Defensive redirect if user landed here without a token\.\s*\n\s+if \(!token\) \{\s*\n\s+window\.location\.replace\('\/signup'\);\s*\n\s+return;\s*\n\s+\}/,
    );
  });

  it('CRITICAL session label is required + maxlength=120. The label cap matches the server-side Zod schema; drift to longer would let server reject what UI accepts.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/id="session-label"/);
    expect(p).toMatch(/name="label"/);
    expect(p).toMatch(/required/);
    expect(p).toMatch(/maxlength="120"/);
    expect(p).toMatch(/placeholder="my-first-session"/);
  });

  it("CRITICAL Skip-this-step escape pinned. The 'Skip this step? Go to dashboard' link lets impatient customers escape; drift to removing would force-funnel customers through session-create.", () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Skip this step\? <a href="\/" class="text-glow-red underline">Go to dashboard<\/a>/,
    );
  });

  it('CRITICAL on-error setBusy(false) restores submit button. Drift to dropping would leave the button permanently disabled on transient errors (customer stuck).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\} catch \(err\) \{\s*\n\s+setBusy\(false\);\s*\n\s+showBanner\(err && err\.message \? err\.message : 'Failed to create first session\.'\)/,
    );
  });

  it('CRITICAL Step-1 error body JSON-parse fallback pinned — `.catch(() => ({}))`. Drift to dropping would let non-JSON server errors crash the await chain.', () => {
    const p = read(PAGE);

    // 2 mint+session JSON-parse fallbacks.
    const fallbacks = (p.match(/await \w+\.json\(\)\.catch\(\(\) => \(\{\}\)\)/g) ?? []).length;
    expect(fallbacks, '2 JSON-parse fallbacks (mint + session)').toBe(2);
  });

  it('CRITICAL DashboardLayout + withSidebar={false} (onboarding-flow page — no sidebar). Matches W735-W740 auth/onboarding pattern.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/<DashboardLayout title="First session" withSidebar=\{false\}>/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-first-session-page-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
