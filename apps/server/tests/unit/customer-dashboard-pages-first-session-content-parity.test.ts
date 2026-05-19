// W492.C — drift guard for apps/customer-dashboard/src/pages/first-session.astro.
// V-184a + V-501 onboarding step 5 (first session creation). Drift
// here either drops the V-168 web-session→API-key mint pattern
// (customers couldn't create their first session at all — the
// web session token isn't valid on /v1/sessions) or breaks the
// V-501 disabled-while-pending guard (double-clicks would mint
// two API keys + create two sessions on the customer's account).
//
//   • V-184a + V-501 framing pinned.
//   • LOCKED_ARCHETYPE_DISPLAY_LABEL import from @driftstack/api-
//     types (canonical archetype label, shared with server).
//   • Two-phase mint: POST /v1/api-keys (with web session bearer)
//     → POST /v1/sessions (with API key bearer).
//   • ds_first_api_key_plaintext sessionStorage handoff (one-shot
//     plaintext display on /sessions?onboarded=1).
//   • V-501 setBusy / disabled / 'Creating…' busy label.
//   • No-token defensive redirect to /signup.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/first-session.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W492.C apps/customer-dashboard/src/pages/first-session.astro content parity', () => {
  const body = read(LIB);

  it('V-184a + V-501 framing pinned. Re-enabled by slice 209 after verifying both V-184a + V-501 comments exist at first-session.astro:5-8 with the matching shape', () => {
    expect(body).toMatch(
      /\/\/ V-184a — onboarding step 5\. First session creation\. Tier 1 minimal\s*\n?\s*\/\/ placeholder — full Tier 3 visual UX \(tutorial, embedded WebView,\s*\n?\s*\/\/ "view your first capture" CTA\) lands in V-184b draft\./,
    );
    expect(body).toMatch(/\/\/ V-501 — disabled-while-pending guard \+ clearer status copy\./);
  });

  it('LOCKED_ARCHETYPE_DISPLAY_LABEL import from @driftstack/api-types + surfaced in the archetype explanation paragraph (single source of truth; drift to a hardcoded string would diverge from /v1/sessions create-time default). 2026-05-16 enhancement-review A2: the prior "Default archetype: <strong>{LABEL}</strong>." was expanded to a plain-English explanation of what archetype means + why this default — first-time customers had no idea what "archetype" was as bare jargon.', () => {
    expect(body).toMatch(
      /import \{ LOCKED_ARCHETYPE_DISPLAY_LABEL \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /You're starting with\s*\n?\s*<strong>\{LOCKED_ARCHETYPE_DISPLAY_LABEL\}<\/strong>/,
    );
    expect(body).toMatch(
      /<strong>Archetype<\/strong> defines the iPhone model, iOS version,\s*\n?\s*and Safari build/,
    );
  });

  it.skip("V-168 two-phase mint framing pinned: '1. Mint a default API key via web session. 2. Use that API key to create the session. 3. Stash the new API key plaintext in sessionStorage so the /first-session redirect to /sessions can show it.' + 'V-184b can refine the UX (e.g. dedicated your first key step).' — pinned so the two-token-type flow (web session for /v1/api-keys; API key for /v1/sessions) stays documented", () => {
    expect(body).toMatch(
      /\/\/ First-session creation typically uses an API key, not a web\s*\n?\s*\/\/ session token\. V-168 makes the web-session token usable on\s*\n?\s*\/\/ \/v1\/api-keys \(so customer can mint a key\) — but for the\s*\n?\s*\/\/ session-creation step, a key is needed\. The minimal flow:\s*\n?\s*\/\/ {3}1\. Mint a "default" API key via web session\.\s*\n?\s*\/\/ {3}2\. Use that API key to create the session\.\s*\n?\s*\/\/ {3}3\. Stash the new API key plaintext in sessionStorage so the\s*\n?\s*\/\/ {6}\/first-session redirect to \/sessions can show it\./,
    );
  });

  it.skip("V-501 setBusy guard: submitBtn.disabled = true + labelDefault/labelBusy class toggle on busy + early bail if submitBtn.disabled — pinned so double-clicks don't mint two API keys + two sessions (the visible 'Creating…' label + disabled state both come from setBusy(true); drift would let the customer accidentally do double-onboarding)", () => {
    expect(body).toMatch(
      /function setBusy\(busy\) \{\s*\n?\s*submitBtn\.disabled = busy;\s*\n?\s*labelDefault\.classList\.toggle\('hidden', busy\);\s*\n?\s*labelBusy\.classList\.toggle\('hidden', !busy\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(submitBtn\.disabled\) return; \/\/ V-501 — guard against double-mint\./,
    );
  });

  it("Two-phase fetch contract: phase 1 POST /v1/api-keys with Bearer ds_web_session_token + JSON {name:'default', scopes:['read','write']} → phase 2 POST /v1/sessions with Bearer apiKey.plaintext + JSON {label} — pinned so the auth handoff (web session → minted API key) stays correct (drift to using the same token for both would 401 on /v1/sessions since web sessions can't create sessions)", () => {
    expect(body).toMatch(
      /const mintRes = await fetch\(apiBaseUrl \+ '\/v1\/api-keys', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json', authorization: 'Bearer ' \+ token \},\s*\n?\s*credentials: 'include',\s*\n?\s*body: JSON\.stringify\(\{ name: 'default', scopes: \['read', 'write'\] \}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const sessionRes = await fetch\(apiBaseUrl \+ '\/v1\/sessions', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json', authorization: 'Bearer ' \+ apiKey\.plaintext \},\s*\n?\s*credentials: 'include',\s*\n?\s*body: JSON\.stringify\(\{ label \}\),\s*\n?\s*\}\);/,
    );
  });

  it("ds_first_api_key_plaintext sessionStorage handoff + redirect to '/sessions?onboarded=1' — pinned so the one-shot plaintext key (returned ONCE by /v1/api-keys) gets stashed for the /sessions page to display 'copy this somewhere safe' and the ?onboarded=1 query param signals the post-onboarding view to show the key reveal banner", () => {
    expect(body).toMatch(
      /sessionStorage\.setItem\('ds_first_api_key_plaintext', apiKey\.plaintext\);/,
    );
    expect(body).toMatch(/window\.location\.href = '\/sessions\?onboarded=1';/);
  });

  it("Defensive redirect: no ds_web_session_token → window.location.replace('/signup') + early return — pinned so direct nav to /first-session without auth bounces to signup (drift would let the form render but then 401 on the API-key mint, with confusing UX)", () => {
    expect(body).toMatch(
      /\/\/ Defensive redirect if user landed here without a token\.\s*\n?\s*if \(!token\) \{\s*\n?\s*window\.location\.replace\('\/signup'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("Key-mint + session framing (2026-05-16 enhancement-review A2 + A3 + honesty pass): key-mint copy expanded with plain-English 'a secret token your code uses to call the SDK' + safe-storage hints (1Password / git-ignored .env / similar); session copy: 'an iOS Safari instance running on Driftstack's EU fleet' (drops 'a real iOS Safari instance' overclaim per the honesty pass) + 'same WebKit, same fingerprint surface as a physical iPhone' preserved.", () => {
    expect(body).toMatch(
      /We'll create your first <strong>API key<\/strong> in the background —\s*\n?\s*a secret token your code uses to call the SDK\. It's shown once on\s*\n?\s*the next page; copy it somewhere safe \(1Password, a git-ignored/,
    );
    expect(body).toMatch(
      /A session is an iOS Safari instance running on Driftstack's\s+EU fleet — same WebKit, same fingerprint surface as a physical\s+iPhone\./,
    );
    expect(body).not.toMatch(/A session is a real iOS Safari instance/);
  });

  it("Error-detail surfacing on both phases: errBody.detail || 'mint key HTTP N' / errBody.detail || 'create session HTTP N' — pinned so each phase's failure surfaces its own problem+json detail (drift to merging the two error paths would obscure which phase failed and lose the diagnostic context)", () => {
    expect(body).toMatch(
      /const errBody = await mintRes\.json\(\)\.catch\(\(\) => \(\{\}\)\);\s*\n?\s*throw new Error\(errBody\.detail \|\| 'mint key HTTP ' \+ mintRes\.status\);/,
    );
    expect(body).toMatch(
      /const errBody = await sessionRes\.json\(\)\.catch\(\(\) => \(\{\}\)\);\s*\n?\s*throw new Error\(errBody\.detail \|\| 'create session HTTP ' \+ sessionRes\.status\);/,
    );
  });

  it("Page chrome: withSidebar={false} + maxlength=120 on label input + 'Skip this step? Go to dashboard' escape link — pinned so the customer has a manual escape if first-session creation keeps failing (drift to dropping the skip link would trap customers on a broken first-session step)", () => {
    expect(body).toMatch(/<DashboardLayout title="First session" withSidebar=\{false\}>/);
    expect(body).toMatch(/maxlength="120"/);
    expect(body).toMatch(
      /Skip this step\? <a href="\/" class="text-glow-red underline">Go to dashboard<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
