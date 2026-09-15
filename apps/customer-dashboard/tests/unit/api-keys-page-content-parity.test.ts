// W357.B — drift guard for customer-dashboard /api-keys page
// content. The endpoint-parity + route-parity guards already pin
// where the page calls the server; this guard pins the
// customer-facing copy + the granular-scope picker against the
// ApiKeyScopeSchema source-of-truth.
//
// Pinned:
//   • Granular scope checkbox set on the form is a subset of
//     ApiKeyScopeSchema's granular values (V-481) — every
//     verb:resource checkbox matches a real enum value.
//   • Four scope-choice radios (account_owner / write / read /
//     granular) with the load-bearing description copy.
//   • Plaintext-shown-ONCE claim on both the create-reveal pane
//     + the rotate-reveal pane.
//   • Rotation grace-window framing (old key keeps working until
//     grace expiry; deploy new key first or get 401s).
//   • scrypt-hashed-at-rest security claim ↔ "no admin recovery
//     path" framing.
//   • Authorization: Bearer <key> header convention.
//   • localStorage key ds_web_session_token (customer-dashboard
//     convention — a rename here without migration locks every
//     customer out).
//   • Footer scope summary copy (read = list/get-only,
//     write = sessions+navigate+interact, account_owner = full).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema, TIER_FEATURES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W357.B customer-dashboard /api-keys page content parity', () => {
  const body = read(PAGE);
  const scopes = new Set<string>((ApiKeyScopeSchema._def as { values: readonly string[] }).values);

  it('granular scope checkbox set is a subset of ApiKeyScopeSchema (V-481)', () => {
    // Every verb:resource checkbox value must resolve to a real
    // enum value — otherwise the server returns 400 on submit.
    const granularPicker = [
      'read:sessions',
      'write:sessions',
      'read:profiles',
      'write:profiles',
      'admin:profiles',
      'read:webhooks',
      'write:webhooks',
      'admin:webhooks',
      'read:api-keys',
      'admin:api-keys',
      'read:billing',
      'admin:billing',
      'read:audit',
    ] as const;
    for (const s of granularPicker) {
      expect(scopes.has(s), `scope missing from ApiKeyScopeSchema: ${s}`).toBe(true);
      expect(body).toContain(`value="${s}"`);
    }
  });

  it('four scope-choice radios pinned with load-bearing description copy', () => {
    // account_owner / write / read / granular — order matters for
    // the "account_owner checked" default below.
    expect(body).toMatch(/value="account_owner"\s+checked/);
    expect(body).toMatch(
      /<strong>account_owner<\/strong>\s*—\s*full access\. Manage webhooks, billing and create\s+other keys/,
    );
    expect(body).toMatch(
      /<strong>write<\/strong>\s*—\s*create and control sessions; can't create other keys, manage\s+webhooks or change billing/,
    );
    expect(body).toMatch(/<strong>read<\/strong>\s*—\s*view only; can't change anything/);
    expect(body).toMatch(/<strong>granular \(advanced\)<\/strong>/);
    expect(body).toMatch(/trusted admin use or your main automation/);
    expect(body).not.toMatch(/keys driving the GUI client/);
  });

  it('full-key-shown-only-once claim pinned on the header + create-reveal pane', () => {
    // V-270 — single load-bearing copy line. A future copy revamp
    // must not water this down to "we'll show it again later".
    expect(body).toMatch(/The full key is\s+shown only once, when you create it/);
    expect(body).toMatch(/save it right away; we can't show it again/);
    expect(body).toMatch(/This is the only time the full key is shown/);
  });

  it('rotation old-key framing pinned (update everything that uses it, or requests get rejected)', () => {
    // V-296b — rotate-reveal pane. The old-key deadline is the only
    // thing between a rotation and an outage; the copy must keep
    // calling that out.
    expect(body).toMatch(/API key rotated/);
    expect(body).toMatch(/The old key keeps\s+working until the time shown below/);
    expect(body).toMatch(
      /update everything that uses it\s+before then, or those requests will be rejected/,
    );
  });

  it('one-way-hash security notice pinned + "not even by Driftstack support"', () => {
    expect(body).toMatch(/We store only a one-way hash of each key/);
    expect(body).toMatch(/Driftstack staff can't read your keys/);
    expect(body).toMatch(/would see only those hashes, not your keys/);
    expect(body).toMatch(/A lost key can't be\s+recovered — not even by Driftstack support/);
  });

  it('Authorization: Bearer header convention pinned', () => {
    expect(body).toMatch(/Authorization: Bearer\s*&lt;key&gt;/);
  });

  it('combines canonical effective tier with caller-only self/team write authority', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(body).toMatch(/import \{ TIER_FEATURES \} from '@driftstack\/api-types'/);
    expect(body).toMatch(
      /Object\.entries\(TIER_FEATURES\)\.map\(\(\[tier, features\]\) => \[tier, features\.apiAccess\]\)/,
    );
    expect(body).toMatch(/data-tier-api-access=\{JSON\.stringify\(tierApiAccess\)\}/);
    expect(body).toMatch(/JSON\.parse\(root\.getAttribute\('data-tier-api-access'\) \|\| '\{\}'\)/);
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/usage'/);
    expect(body).toMatch(/headers: effectiveHeaders,\s*signal: controller\.signal/);
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/account\/me'/);
    expect(body).toMatch(/headers: callerOnlyHeaders\(\),\s*signal: controller\.signal/);
    expect(body).toMatch(
      /function callerOnlyHeaders\(extra = \{\}\) \{[\s\S]*?authorization: 'Bearer ' \+ token,[\s\S]*?\};\s*\}/,
    );
    expect(body).not.toMatch(
      /function callerOnlyHeaders\(extra = \{\}\) \{[\s\S]*?window\.driftstackActAsHeaders/,
    );
    expect(body).toMatch(/Object\.prototype\.hasOwnProperty\.call\(tierApiAccess, tier\)/);
    expect(body).toMatch(/const writeAccess = resolveWriteAccess\(me, selectedId\)/);
    expect(body).toMatch(/if \(!selectedId \|\| selectedId === me\.id\)/);
    expect(body).toMatch(/matches\.length !== 1/);
    expect(body).toMatch(/role !== 'admin' && role !== 'member'/);
    expect(body).toMatch(/granted: role === 'admin'/);
    expect(body).toMatch(/class="btn-primary hidden"\s*data-show-create\s*data-api-write-only/);
    expect(body).toMatch(/class="dashboard-card mb-8 hidden" data-api-access-only/);
    expect(body).toMatch(
      /\/v1\/usage supplies the selected effective account's tier[\s\S]*?caller-only \/v1\/account\/me supplies self identity plus team roles/,
    );
  });

  it('keeps paid SDK guidance separate from team-admin-only mutations and guards forced DOM paths', () => {
    expect(body).toMatch(/const canWrite = canWriteSelectedAccount\(\)/);
    expect(body).toMatch(/const canRotate = canWrite && apiAccessVerified && apiAccessGranted/);
    expect(body).toMatch(/\(canRotate \? '' : ' hidden'\)/);
    expect(body).toMatch(/\(canWrite \? '' : ' hidden'\)/);
    expect(body).toMatch(/apiAccessOnly\.forEach[\s\S]*?!showPaidGuidance/);
    expect(body).toMatch(/apiWriteOnly\.forEach[\s\S]*?!showWriteControls/);
    expect(body).toContain('team role is read-only for the selected account');
    expect(body).toContain('Ask a team admin to create, rotate, or revoke keys.');
    expect(body).toMatch(
      /function wireRevokeButtons\(\)[\s\S]*?if \(!writeAccessVerified \|\| !writeAccessGranted\)/,
    );
    expect(body).toMatch(
      /function wireRotateButtons\(\)[\s\S]*?!writeAccessVerified[\s\S]*?!writeAccessGranted/,
    );
    expect(
      body.match(/!writeAccessVerified \|\|\s*!writeAccessGranted/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(body).toMatch(/if \(!showWriteControls\) \{[\s\S]*?revealPre\.textContent = ''/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    // Rename here without a coordinated migration would silently
    // sign every customer out of the page.
    expect(body).toContain("'ds_web_session_token'");
    expect(body).toMatch(/try\s*\{\s*return localStorage\.getItem\('ds_web_session_token'\);/);
    expect(body).toMatch(/catch\s*\{\s*return null;/);
    expect(body).toMatch(
      /if \(!token\)[\s\S]*?renderUnavailable\('Sign in to load your API keys\.'\)[\s\S]*?window\.dashboardHydrated\(\);[\s\S]*?return;/,
    );
  });

  it('bounds hydration and serializes every API-key mutation', () => {
    expect(body).toContain('const API_KEY_TIMEOUT_MS = 15_000;');
    expect(body).toContain('const mutationButtonsInFlight = new WeakSet();');
    expect(body).toContain('let createInFlight = false;');
    expect(body).toMatch(/if \(mutationButtonsInFlight\.has\(btn\)\) return;/);
    expect(body).toMatch(/if \(createInFlight\) return;/);
    expect(body.match(/signal: controller\.signal/g)?.length).toBeGreaterThanOrEqual(4);
    expect(body).toContain('Loading API keys took too long. Check your connection and retry.');
    expect(body).toContain("The request took too long, so we can't be sure it finished. ");
    expect(body).toContain(
      "The request took too long, so we can't be sure the rotation finished. ",
    );
    expect(body).toContain("its value can't be shown again");
    expect(body).toContain('Revoke it before creating another key');
    expect(body).toContain('Revoke that new key before rotating again');
    expect(body).toContain('const ambiguousRevokeIds = new Set();');
    expect(body).toContain('const ambiguousRotateIds = new Set();');
    expect(body).toContain('let keySnapshot = [];');
    expect(body).toMatch(/!keyIdsBefore\.has\(key\.id\)/);
    expect(body).toMatch(/String\(key\.name \|\| ''\) === String\(name\)/);
    expect(body).toMatch(
      /createSubmit\.disabled = !canManageApiKeys\(\) \|\| createOutcomeBlocked/,
    );
    expect(body).toMatch(/if \(createOutcomeBlocked\)/);
    expect(body).toMatch(/lockRotateAction\(sourceId, Boolean\(matchingKey\)\)/);
    expect(body).toMatch(/if \(ambiguousRotateIds\.has\(String\(id \|\| ''\)\)\)/);
    expect(body).toContain("Your list doesn't show a new “");
    expect(body).toContain('async function reconcileAmbiguousRevoke(id, name)');
    expect(body).toMatch(/if \(ambiguousRevokeIds\.has\(String\(id \|\| ''\)\)\) return/);
    expect(body).toContain("The request took too long and we couldn't refresh your key list.");
    expect(body).toContain("It was most likely revoked; don't revoke it again.");
    expect(body).toMatch(/btn\.disabled = outcomeUnknown/);
  });

  it('supersedes stale list reads and cancels hydration on page exit', () => {
    expect(body).toContain('let refreshController = null;');
    expect(body).toContain('let refreshGeneration = 0;');
    expect(body).toMatch(/if \(refreshController\) refreshController\.abort\(\)/);
    expect(body).toMatch(/const isCurrent = \(\) => generation === refreshGeneration/);
    expect(body).toMatch(/if \(!isCurrent\(\)\) return;/);
    expect(body).toMatch(/window\.addEventListener\('pagehide'/);
  });

  it('footer scope summary copy stays accurate (broad scopes only — granular not promoted here)', () => {
    // V-174 — footer summary. Mentions read/write/account_owner
    // explicitly and recommends giving each key only the access it needs.
    expect(body).toMatch(/<code class="font-mono">read<\/code> \(view only\)/);
    expect(body).toMatch(/<code class="font-mono">write<\/code>\s*\(create and control sessions\)/);
    expect(body).toMatch(
      /<code class="font-mono">account_owner<\/code>\s*\(also manage webhooks, billing and other keys/,
    );
    expect(body).toMatch(/Give each key only the access it needs/);
  });

  it('SCOPE_LABEL map exposes a label for every broad scope cited in the form', () => {
    // The form lets users pick account_owner / write / read +
    // granular scopes — the SCOPE_LABEL map governs how those
    // render as badges on the list. Make sure the broad scopes
    // are all present.
    for (const broad of [
      'read',
      'write',
      'admin',
      'account_owner',
      'driftstack_internal_admin',
      'gui_control',
    ]) {
      expect(body).toMatch(new RegExp(`${broad}:\\s*'[a-z_]+'`));
    }
  });

  it("Fleet v2 (slice 3.5): the 'use it now' quickstart uses a ds_live_ PLACEHOLDER, never a real key, and the header links docs — the one-time plaintext must never leak into static markup", () => {
    // The snippet documents the header shape with a placeholder token.
    expect(body).toMatch(/Authorization: Bearer ds_live_&lt;your-key&gt;/);
    expect(body).toMatch(/npm i @driftstack\/sdk/);
    // Contextual docs deep-links (absolute cross-origin; rel guarded by the sweep).
    expect(body).toContain('https://docs.driftstack.io/api/api-keys/');
    expect(body).toContain('https://docs.driftstack.io/api/auth/');
    // Safety: no created/rotate plaintext data-attr value is ever baked into
    // the static snippet region — the real key lives only in the reveal
    // panes (which wipe on dismiss), never in server-rendered HTML.
    expect(body).not.toMatch(/ds_live_[a-z0-9]{8,}/i);
  });
});
