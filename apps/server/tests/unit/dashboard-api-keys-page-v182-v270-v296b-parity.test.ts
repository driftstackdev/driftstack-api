// W750 — customer-dashboard /api-keys.astro V-182 (live-list) +
// V-270 (create/revoke) + V-296b (rotate-reveal pane) + V-481
// (granular-scope picker) parity. Seventy-sixth in the cross-SDK
// drift-guard series.
//
// The /api-keys page is the ONLY surface where customers see plaintext
// API keys. The "shown once on creation" + "no admin recovery path"
// + "scrypt-hashed at rest" framing is the load-bearing security
// posture for the entire API-key product.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro');

describe('W750 dashboard /api-keys page V-182 + V-270 + V-296b + V-481 parity', () => {
  it('api-keys.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-182 + V-270 anchor framing pinned. The two-line frontmatter — "V-182 — progressive-enhancement wiring against /v1/api-keys." + "V-270 — wired the New-key form + revoke confirmation flow." — threads BOTH the live-list anchor + the form-flow anchor.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-182 — progressive-enhancement wiring against \/v1\/api-keys\./);
    expect(p).toMatch(/V-270 — wired the New-key form \+ revoke confirmation flow\./);
  });

  it('CRITICAL plaintext-shown-ONCE-on-creation framing pinned. The header copy — "Plaintext is shown ONCE on creation — store it now; we can\'t recover it later. Revocation is immediate." — is the load-bearing security framing.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Plaintext is\s*\n\s+shown ONCE on creation — store it now; we can't recover it later\. Revocation is\s*\n\s+immediate\./,
    );
  });

  it('CRITICAL scrypt-hash + no-admin-recovery security framing pinned. The wording — "API keys are scrypt-hashed at rest. Driftstack staff cannot read your keys — a database breach surfaces hashes, not keys" — is the customer-facing breach-resilience contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /API keys are scrypt-hashed at rest\. Driftstack staff cannot read your keys — a database/,
    );
    expect(p).toMatch(/breach surfaces hashes, not keys/);
    expect(p).toMatch(/If a key leaks, revoke \+ rotate; no admin recovery/);
    expect(p).toMatch(/path exists/);
  });

  it('CRITICAL 4-broad-scope set pinned — account_owner / write / read / granular. Drift to adding or dropping a top-level radio would force customers to scroll through 8+ tiers; the 4-shape is what fits on the create-form panel.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/value="account_owner"\s*\n\s+checked\s*\n\s+class="mt-0\.5"/);
    expect(p).toMatch(/<input type="radio" name="scope" value="write" class="mt-0\.5" \/>/);
    expect(p).toMatch(/<input type="radio" name="scope" value="read" class="mt-0\.5" \/>/);
    expect(p).toMatch(/value="granular"/);
  });

  it("CRITICAL V-481 granular-scope picker reveal — radio.value === 'granular' && radio.checked toggles the picker visibility. Drift to dropping the gate would always-show the picker (clutter) or never-show (broken submit).", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-481 — show\/hide the granular scope picker when the/);
    expect(p).toMatch(
      /if \(radio\.value === 'granular' && radio\.checked\) \{\s*\n\s+granularPanel\.classList\.remove\('hidden'\);\s*\n\s+\} else if \(radio\.checked\) \{/,
    );
  });

  it('CRITICAL V-481 granular-submission resolves to fd.getAll("granular-scope") array. Drift to a single-value would force customers to repeat the create flow N times for N permissions.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-481 — granular submission resolves to the array of checked/);
    expect(p).toMatch(/checkbox values; broad submission resolves to a single scope/);
    expect(p).toMatch(
      /if \(scope === 'granular'\) \{\s*\n\s+scopes = fd\.getAll\('granular-scope'\)\.map\(\(v\) => v\.toString\(\)\);/,
    );
  });

  it("CRITICAL 6-resource granular-scope picker pinned — Sessions/Profiles/Webhooks/API keys/Billing/Audit. Each fieldset is a legend + 1+ checkbox. Drift to dropping a resource fieldset would silently lock customers out of that resource's narrow-scope option.", () => {
    const p = read(PAGE);

    for (const legend of ['Sessions', 'Profiles', 'Webhooks', 'API keys', 'Billing', 'Audit']) {
      expect(p, `${legend} legend`).toMatch(
        new RegExp(
          `<legend class="font-mono text-xs uppercase tracking-wide text-tk-ink-3">\\s*\\n\\s+${legend.replace(/\s+/g, '\\s+')}\\s*\\n\\s+</legend>`,
        ),
      );
    }

    // Drift-guard the 6 most load-bearing scope values.
    expect(p).toMatch(/value="read:sessions"/);
    expect(p).toMatch(/value="write:sessions"/);
    expect(p).toMatch(/value="admin:profiles"/);
    expect(p).toMatch(/value="admin:webhooks"/);
    expect(p).toMatch(/value="admin:api-keys"/);
    expect(p).toMatch(/value="read:audit"/);
  });

  it("CRITICAL revoke-confirm prompt pinned — 'Apps using this key will start receiving 401 immediately. This cannot be undone.' The 401-immediately framing is the load-bearing customer-warning before destructive action.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /'Revoke "' \+\s*\n\s+name \+\s*\n\s+'"\? Apps using this key will start receiving 401 immediately\. This cannot be undone\.',/,
    );
  });

  it('CRITICAL revoke method = DELETE on /v1/api-keys/<id> + 204-or-error handling. Drift to a 200-only check would let the 204-on-success response trigger a false-positive error path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/api-keys\/' \+ encodeURIComponent\(id\), \{\s*\n\s+method: 'DELETE',/,
    );
    expect(p).toMatch(/if \(!r\.ok && r\.status !== 204\) \{/);
  });

  it("CRITICAL V-296b dedicated rotate-reveal pane framing pinned. The 'V-296b — dedicated rotate-reveal pane wiring (mirrors V-475 webhook rotate-secret pattern). Replaces the earlier reuse of the create-flow pane.' wording is what explains WHY rotate has its own pane.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-296b — dedicated rotate-reveal pane wiring \(mirrors V-475/);
    expect(p).toMatch(/webhook rotate-secret pattern\)\. Replaces the earlier reuse of/);
    expect(p).toMatch(/the create-flow pane\./);
  });

  it("CRITICAL rotate-confirm 24h grace-period framing pinned. The wording — 'the old key keeps working for a 24h grace period so you can swap deployments without downtime' — is the load-bearing operator framing that allows zero-downtime rotation.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /'Rotate "' \+\s*\n\s+name \+\s*\n\s+'"\? A new plaintext is shown ONCE; the old key keeps working for a 24h grace period so you can swap deployments without downtime\.',/,
    );
  });

  it("CRITICAL rotate POST /v1/api-keys/<id>/rotate + body '{}'. Drift to omitting the body would break content-length expectations on some Node middleware; the empty-object body satisfies the application/json content-type.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/api-keys\/' \+ encodeURIComponent\(id\) \+ '\/rotate', \{\s*\n\s+method: 'POST',\s*\n\s+headers: \{\s*\n\s+authorization: 'Bearer ' \+ token,\s*\n\s+'content-type': 'application\/json',\s*\n\s+\},\s*\n\s+body: '\{\}',\s*\n\s+\}\)/,
    );
  });

  it("CRITICAL rotate-reveal 3-field display pinned — rotated_from + plaintext + grace_period_ends_at. The 'V-296b — surface the rotated_from + grace_period_ends_at fields the response carries; not just the plaintext' framing is what justifies the 3-field reveal pane.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-296b — surface the rotated_from \+ grace_period_ends_at/);
    expect(p).toMatch(/fields the response carries; not just the plaintext/);
    expect(p).toMatch(
      /showRotateReveal\(\s*\n\s+body\.rotated_from \|\| '',\s*\n\s+body\.plaintext \|\| '',\s*\n\s+body\.grace_period_ends_at \|\| '',\s*\n\s+\)/,
    );
  });

  it('CRITICAL rotate-reveal plaintext wipe on dismiss. The "Wipe plaintext from DOM so it isn\'t recoverable post-dismiss" framing is the load-bearing post-rotation-cleanup contract (matches W736 magic-link single-use posture).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ Wipe plaintext from DOM so it isn't recoverable post-dismiss/);
    expect(p).toMatch(
      /rotateReveal\.classList\.add\('hidden'\);\s*\n\s+\/\/ Wipe plaintext from DOM so it isn't recoverable post-dismiss\.\s*\n\s+rotatePlaintext\.textContent = ''/,
    );
  });

  it('CRITICAL "Key created — copy it now" reveal pane pinned. The "This is the only time the full key is shown. Store it in your secret manager before dismissing." framing is the load-bearing one-shot-copy customer-comms.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Key created — copy it now/);
    expect(p).toMatch(
      /This is the only time the full key is shown\. Store it in your secret manager before\s*\n\s+dismissing\./,
    );
  });

  it("CRITICAL revealDismiss handler clears plaintext via revealPre.textContent = ''. Drift to using innerHTML='' would let a renderer-retained reference survive the DOM update.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /revealDismiss\.addEventListener\('click', \(\) => \{\s*\n\s+revealPre\.textContent = '';\s*\n\s+reveal\.classList\.add\('hidden'\);\s*\n\s+\}\)/,
    );
  });

  it('CRITICAL 6-scope SCOPE_LABEL map pinned with internal_admin + gui aliases. driftstack_internal_admin → internal_admin shortens the badge display; gui_control → gui matches the GUI activation flow naming.', () => {
    const p = read(PAGE);

    // One executable source in the live hydration script; the unused
    // frontmatter duplicate was removed so diagnostics stay high-signal.
    expect((p.match(/driftstack_internal_admin: 'internal_admin'/g) ?? []).length).toBe(1);
    expect((p.match(/gui_control: 'gui'/g) ?? []).length).toBe(1);
  });

  it('CRITICAL fmtIso() relative-day formatting pinned in the executable inline script — today/yesterday/<N> days ago/<absolute>. The 30-day cutoff matches /sessions fmtIso convention.', () => {
    const p = read(PAGE);

    // Relative-day phrasing (4 cases).
    for (const phrase of [
      "return 'today'",
      "return 'yesterday'",
      'days ago',
      'toISOString().slice(0, 10)',
    ]) {
      const occurrences = (p.match(new RegExp(phrase.replace(/[.()/]/g, '\\$&'), 'g')) ?? [])
        .length;
      expect(occurrences, `phrase ${phrase}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("CRITICAL S35 2026-07-07 (fable-frontend-audit) — fmtIso() FUTURE-timestamp branch pinned in the executable copy. A rotated key's grace expiry (expires_at = now+24h) used to hit the floor()d day math and render 'grace ends -1 days ago' for the whole grace window; future values now render 'in <1h' / 'in Nh' / 'in N days'. Drift back to past-only math resurrects the negative-days display.", () => {
    const p = read(PAGE);

    for (const phrase of [
      'if (diffMs < 0)',
      "return 'in <1h'",
      'aheadHours',
      'aheadDays',
    ] as const) {
      const occurrences = (p.match(new RegExp(phrase.replace(/[.()<]/g, '\\$&'), 'g')) ?? [])
        .length;
      expect(occurrences, `phrase ${phrase}`).toBeGreaterThanOrEqual(1);
    }
    // The 48h hour→day cutover (hours read better than
    // '0 days'/'1 days' inside a 24h grace window).
    expect((p.match(/aheadHours < 48/g) ?? []).length).toBe(1);
  });

  it("CRITICAL Bullet-mask 24-char visual key-truncation pinned — `'•'.repeat(24)`. Drift to a different fill-char or count would change the visible key-shape on the dashboard. 2026-05-21 — SSR no longer renders keys (skeleton-only pre-hydration; 12566e61); only the JS-side render keeps the bullet mask.", () => {
    const p = read(PAGE);

    // Inline-script version — JS-side render still uses the 24-bullet mask.
    expect(p).toMatch(/'•'\.repeat\(24\)/);
  });

  it('CRITICAL escapeHtml() 5-char XSS guard pinned in inline script. Every dynamically-rendered key field (id, name, scopes, key_prefix) flows through it. Drift to dropping would let a malicious key name (post compromise) inject HTML into the list.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/'&': '&amp;'/);
    expect(p).toMatch(/'<': '&lt;'/);
    expect(p).toMatch(/'>': '&gt;'/);
    expect(p).toMatch(/'"': '&quot;'/);
    expect(p).toMatch(/"'": '&#39;'/);

    const escapeUsages = (p.match(/escapeHtml\(/g) ?? []).length;
    expect(escapeUsages).toBeGreaterThanOrEqual(10);
  });

  it('CRITICAL no-token preview-fallback pinned — "Sign in to see live API keys. Showing preview data below." Drift to a 401 redirect would lose the preview-of-real-product affordance (matches W749 /sessions framing).', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /showBanner\('Sign in to see live API keys\. Showing preview data below\.'\);\s*\n\s+return;/,
    );
  });

  it("CRITICAL key-row 'grace ends' inline annotation pinned. When a key has expires_at set (post-rotation), the row shows ' · <span class=\"text-tk-accent-text\">grace ends <iso>' as inline metadata (S23 2026-07-06 AA text tone). Drift would hide the grace-deadline from the customer.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\(k\.expires_at\s*\n\s+\? ' · <span class="text-tk-accent-text">grace ends ' \+\s*\n\s+escapeHtml\(fmtIso\(k\.expires_at\)\) \+\s*\n\s+'<\/span>'\s*\n\s+: ''\)/,
    );
  });

  it("CRITICAL revoked-key 'revoked <date>' badge pinned. Drift to hiding revoked keys would lose audit-trail visibility; drift to active-actions would let customers re-revoke an already-revoked key.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/const isRevoked = k\.revoked_at !== null && k\.revoked_at !== undefined;/);
    expect(p).toMatch(
      /'<span class="rounded-full bg-tk-surface px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-tk-ink-2">revoked '/,
    );
  });

  it('CRITICAL POST /v1/api-keys body shape pinned — { name, scopes: array }. Drift to a single-scope string would break the V-481 granular flow; drift to dropping name would force the server to generate one.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/body: JSON\.stringify\(\{ name: name, scopes: scopes \}\)/);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used. /api-keys IS sidebar-enabled — customers navigate from here to sessions and back.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="API keys">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-api-keys-page-v182-v270-v296b-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
