// W496.C — drift guard for apps/customer-dashboard/src/pages/api-keys.astro.
// V-182 + V-270 + V-296b + V-481 api-keys page. Drift here either
// drops the 'plaintext shown ONCE on creation' framing (customers
// would expect to recover lost keys and file unfixable support
// tickets when they can't) or breaks the V-296b dedicated rotate
// pane (would re-introduce the V-475-fixed problem of rotate
// reusing the create flow without surfacing grace_period_ends_at).
//
//   • V-182 + V-270 progressive-enhancement framing pinned.
//   • SCOPE_LABEL 6-entry: read/write/admin/account_owner/
//     driftstack_internal_admin/gui_control.
//   • 4-option scope radio: account_owner (default) / write / read
//     / granular.
//   • V-481 granular scope picker with 6 fieldsets (sessions/profiles/
//     webhooks/api-keys/billing/audit).
//   • V-296b dedicated rotate-reveal pane (replaces V-475-era reuse
//     of create-flow pane).
//   • 'plaintext shown ONCE' + 'scrypt-hashed at rest' framing.
//   • 24h grace period rotate framing.
//   • POST /v1/api-keys + DELETE + POST /:id/rotate contracts.
//   • body.rotated_from + body.plaintext + body.grace_period_ends_at
//     on rotate response.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W496.C apps/customer-dashboard/src/pages/api-keys.astro content parity', () => {
  const body = read(LIB);

  it('V-182 + V-270 framing pinned. Re-enabled by slice 210 after verifying both lines exist verbatim at api-keys.astro:5-6', () => {
    expect(body).toMatch(/\/\/ V-182 — progressive-enhancement wiring against \/v1\/api-keys\./);
    expect(body).toMatch(/\/\/ V-270 — wired the New-key form \+ revoke confirmation flow\./);
  });

  it("SCOPE_LABEL 6-entry map: read/write/admin/account_owner/driftstack_internal_admin (→ internal_admin) / gui_control (→ gui) — pinned so the scope vocabulary covers ALL emitted scope tokens (drift to dropping driftstack_internal_admin would render staff-emitted scopes as raw token; drift to dropping gui_control mapping would render the GUI client's scope as raw)", () => {
    expect(body).toMatch(
      /const SCOPE_LABEL = \{\s*\n?\s*read: 'read',\s*\n?\s*write: 'write',\s*\n?\s*admin: 'admin',\s*\n?\s*account_owner: 'account_owner',\s*\n?\s*driftstack_internal_admin: 'internal_admin',\s*\n?\s*gui_control: 'gui',\s*\n?\s*\};/,
    );
  });

  it('4-option scope radio with account_owner default: account_owner (checked) / write / read / granular — pinned for trusted administration/automation without claiming desktop-app credential reuse', () => {
    expect(body).toMatch(
      /<input\s*\n?\s*type="radio"\s*\n?\s*name="scope"\s*\n?\s*value="account_owner"\s*\n?\s*checked/,
    );
    expect(body).toMatch(/<input type="radio" name="scope" value="write"/);
    expect(body).toMatch(/<input type="radio" name="scope" value="read"/);
    expect(body).toMatch(
      /<input\s*\n?\s*type="radio"\s*\n?\s*name="scope"\s*\n?\s*value="granular"/,
    );
    expect(body).toMatch(
      /Choose this for trusted account administration or your primary\s*\n?\s*automation/,
    );
    expect(body).not.toMatch(/keys driving the GUI client/);
  });

  it('V-481 granular scope picker framing pinned. Re-enabled by slice 268 after restoring the V-481 anchor on the HTML comment at api-keys.astro:124', () => {
    expect(body).toMatch(
      /V-481 — granular scope picker\. Hidden by default; reveals when\s*\n?\s*the "granular" radio is selected\. Submits the raw array of\s*\n?\s*selected `verb:resource` scopes\./,
    );
    expect(body).toMatch(
      /Granular scopes do not satisfy broad checks —\s*\n?\s*if you select <code class="font-mono">read:sessions<\/code> only,/,
    );
  });

  it('V-481 granular scope 6-fieldset taxonomy pinned. Re-enabled by slice 268 — same V-481 anchor restoration as above; the 14-scope matrix assertions test for value="<verb>:<resource>" radio values which were intact', () => {
    expect(body).toMatch(/value="read:sessions"/);
    expect(body).toMatch(/value="write:sessions"/);
    expect(body).toMatch(/value="read:profiles"/);
    expect(body).toMatch(/value="write:profiles"/);
    expect(body).toMatch(/value="admin:profiles"/);
    expect(body).toMatch(/value="read:webhooks"/);
    expect(body).toMatch(/value="write:webhooks"/);
    expect(body).toMatch(/value="admin:webhooks"/);
    expect(body).toMatch(/value="read:api-keys"/);
    expect(body).toMatch(/value="admin:api-keys"/);
    expect(body).toMatch(/value="read:billing"/);
    expect(body).toMatch(/value="admin:billing"/);
    expect(body).toMatch(/value="read:audit"/);
  });

  it('V-296b dedicated rotate-reveal framing pinned. Re-enabled by slice 268 after restoring the V-296b + V-475 anchors on the HTML comment at api-keys.astro:268', () => {
    expect(body).toMatch(
      /V-296b — dedicated rotate reveal pane\. Mirrors the V-475 webhook\s*\n?\s*rotate-secret pattern\. Surfaces the new plaintext \+ grace expiry\s*\n?\s*so the customer knows how long the OLD key keeps working\.\s*\n?\s*Replaces the previous reuse of the create-flow pane \(which\s*\n?\s*didn't surface the grace metadata\)\./,
    );
  });

  it('Rotate response field consumption: body.rotated_from + body.plaintext + body.grace_period_ends_at — pinned so the rotate reveal surfaces ALL 3 server-emitted fields (drift to dropping rotated_from would hide which key was rotated; drift to dropping grace_period_ends_at would hide when the old key stops working, creating downtime risk)', () => {
    expect(body).toMatch(
      /showRotateReveal\(\s*\n?\s*body\.rotated_from \|\| '',\s*\n?\s*body\.plaintext \|\| '',\s*\n?\s*body\.grace_period_ends_at \|\| '',\s*\n?\s*\);/,
    );
  });

  it("'plaintext shown ONCE' framing pinned: 'Plaintext is shown ONCE on creation — store it now; we can't recover it later.' + 'This is the only time the full key is shown. Store it in your secret manager before dismissing.' — pinned so the recovery-impossibility framing survives in BOTH the header copy AND the just-created reveal (drift to dropping would lead to customers filing 'I lost my key, recover it' support tickets we can't satisfy)", () => {
    expect(body).toMatch(
      /Plaintext is\s*\n?\s*shown ONCE on creation — store it now; we can't recover it later/,
    );
    expect(body).toMatch(
      /This is the only time the full key is shown\. Store it in your secret manager before\s*\n?\s*dismissing\./,
    );
  });

  it("scrypt-at-rest security framing pinned: 'API keys are scrypt-hashed at rest. Driftstack staff cannot read your keys — a database breach surfaces hashes, not keys. If a key leaks, revoke + rotate; no admin recovery path exists.' — pinned so the scrypt + breach-resistance + no-admin-recovery framing all survives (drift to dropping would let customers assume staff can read their keys, breaking the security trust model)", () => {
    expect(body).toMatch(
      /API keys are scrypt-hashed at rest\. Driftstack staff cannot read your keys — a database\s*\n?\s*breach surfaces hashes, not keys\. If a key leaks, revoke \+ rotate; no admin recovery\s*\n?\s*path exists\./,
    );
  });

  it("24h grace period rotate framing pinned: 'A new plaintext is shown ONCE; the old key keeps working for a 24h grace period so you can swap deployments without downtime.' — pinned so the dual-validity rotation window (new key minted + old key still valid for 24h) survives (drift to dropping the 24h would either cause confused 'why does my old key still work' tickets or break the zero-downtime swap UX)", () => {
    expect(body).toMatch(
      /A new plaintext is shown ONCE; the old key keeps working for a 24h grace period so you can swap deployments without downtime/,
    );
  });

  it("Revoke confirm + 401-immediately framing pinned: 'Revoke \"<name>\"? Apps using this key will start receiving 401 immediately. This cannot be undone.' — pinned so customers know revocation is instant + irreversible (drift to dropping 'immediately' would let customers think there's a grace window for revoke too, breaking the 'incident response' use case)", () => {
    expect(body).toMatch(
      /'Revoke "' \+\s*\n?\s*name \+\s*\n?\s*'"\? Apps using this key will start receiving 401 immediately\. This cannot be undone\.',/,
    );
  });

  it('effective reads share selected-owner headers while caller role authority strips act-as', () => {
    expect(body).toMatch(
      /function authedHeaders\(extra = \{\}\) \{[\s\S]*?authorization: 'Bearer ' \+ token,[\s\S]*?window\.driftstackActAsHeaders\(\)/,
    );
    expect(body.match(/fetch\(apiBaseUrl \+ '\/v1\/api-keys/g)).toHaveLength(4);
    expect(body.match(/headers: authedHeaders\(/g)).toHaveLength(4);
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/usage', \{\s*headers: effectiveHeaders,\s*signal: controller\.signal/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/account\/me', \{\s*headers: callerOnlyHeaders\(\),\s*signal: controller\.signal/,
    );
    expect(body).toMatch(
      /function callerOnlyHeaders\(extra = \{\}\) \{\s*return \{\s*\.\.\.extra,\s*authorization: 'Bearer ' \+ token,\s*\};\s*\}/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/api-keys', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: authedHeaders\(\{\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*\}\),\s*\n?\s*body: JSON\.stringify\(\{ name: name, scopes: scopes \}\),\s*\n?\s*signal: controller\.signal,/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/api-keys\/' \+ encodeURIComponent\(id\), \{\s*\n?\s*method: 'DELETE',\s*\n?\s*headers: authedHeaders\(\),\s*\n?\s*signal: controller\.signal,/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/api-keys\/' \+ encodeURIComponent\(id\) \+ '\/rotate', \{\s*\n?\s*method: 'POST',[\s\S]*?headers: authedHeaders\(\{\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*\}\),\s*\n?\s*body: '\{\}',\s*\n?\s*signal: controller\.signal,/,
    );
  });

  it('Static, signed-out, and failed list states keep key creation unavailable and replace indefinite skeletons with an explicit non-authoritative row', () => {
    expect(body.match(/data-show-create\s*data-api-write-only\s*disabled/g)).toHaveLength(2);
    expect(body).toMatch(/let keyDataAvailable = false;/);
    expect(body).toMatch(
      /function setCreateAvailability\(available\) \{\s*keyDataAvailable = available;\s*syncApiAccessUi\(\);\s*\}/,
    );
    expect(body).toMatch(
      /const available = canManageApiKeys\(\);[\s\S]*?button\.disabled = !available/,
    );
    expect(body).toMatch(
      /function renderUnavailable\(message\) \{\s*keySnapshot = \[\];\s*setCreateAvailability\(false\);[\s\S]*?ul\.classList\.remove\('hidden'\);[\s\S]*?message \+\s*'<\/li>';/,
    );
    expect(body).toMatch(
      /\.then\(\(body\) => \{\s*if \(!isCurrent\(\)\) return;\s*const keys = body\.data \|\| \[\];\s*keySnapshot = keys;\s*setCreateAvailability\(true\);/,
    );
    expect(body).toMatch(
      /\.catch\(\(err\) => \{\s*if \(!isCurrent\(\)\) return;\s*renderUnavailable\(/,
    );
    expect(body).toMatch(
      /function showCreate\(\) \{\s*if \([\s\S]*?!apiAccessVerified[\s\S]*?!apiAccessGranted[\s\S]*?!writeAccessVerified[\s\S]*?!writeAccessGranted[\s\S]*?\) \{[\s\S]*?if \(!token \|\| !keyDataAvailable\) \{/,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderUnavailable\('Sign in to load your API keys\.'\);\s*showBanner\('Sign in to see live API keys\.'\);[\s\S]*?window\.dashboardHydrated\(\);[\s\S]*?return;/,
    );
    expect(body).not.toMatch(/Showing preview data below/);
  });

  it('canonical entitlement plus exact team role jointly fail closed every write path', () => {
    expect(body).toMatch(/import \{ TIER_FEATURES \} from '@driftstack\/api-types'/);
    expect(body).toMatch(/features\.apiAccess/);
    expect(body).toMatch(/data-tier-api-access=\{JSON\.stringify\(tierApiAccess\)\}/);
    expect(body).toMatch(/JSON\.parse\(root\.getAttribute\('data-tier-api-access'\) \|\| '\{\}'\)/);
    expect(body).toMatch(/Object\.prototype\.hasOwnProperty\.call\(tierApiAccess, tier\)/);
    expect(body).toMatch(/const writeAccess = resolveWriteAccess\(me, selectedId\)/);
    expect(body).toMatch(
      /\/v1\/usage supplies the selected effective account's tier[\s\S]*?caller-only \/v1\/account\/me supplies self identity plus team roles/,
    );
    expect(body).toMatch(/if \(!selectedId \|\| selectedId === me\.id\)/);
    expect(body).toMatch(/matches\.length !== 1/);
    expect(body).toMatch(/role !== 'admin' && role !== 'member'/);
    expect(body).toMatch(/granted: role === 'admin'/);
    expect(body).toMatch(/const canWrite = canWriteSelectedAccount\(\)/);
    expect(body).toMatch(/const canRotate = canWrite && apiAccessVerified && apiAccessGranted/);
    expect(body).toMatch(/\(canRotate \? '' : ' hidden'\)/);
    expect(body).toMatch(/\(canWrite \? '' : ' hidden'\)/);
    expect(body).toMatch(/if \(!showWriteControls\) \{[\s\S]*?revealPre\.textContent = ''/);
    expect(body).toContain('selected team role is read-only');
    expect(
      body.match(/!writeAccessVerified \|\|\s*!writeAccessGranted/g)?.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("Rotate-reveal plaintext-wipe-on-dismiss framing pinned: 'Wipe plaintext from DOM so it isn't recoverable post-dismiss.' + rotatePlaintext.textContent = '' on hide — pinned so the plaintext doesn't linger in the DOM after the customer dismisses (drift to leaving it would let post-dismiss page inspectors recover the plaintext, defeating the 'shown ONCE' contract)", () => {
    expect(body).toMatch(/\/\/ Wipe plaintext from DOM so it isn't recoverable post-dismiss\./);
    expect(body).toMatch(/rotatePlaintext\.textContent = '';/);
  });

  it("Granular at-least-one validation: scopes.length === 0 → granularWarning.hidden = false + early return — pinned so the form can't submit with zero granular scopes (drift to allowing zero would create keys with effectively no permissions; drift to surfacing only after server 400 would force customers through a round-trip for client-side-detectable validation)", () => {
    expect(body).toMatch(
      /if \(scopes\.length === 0\) \{\s*\n?\s*if \(granularWarning\) granularWarning\.hidden = false;\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
