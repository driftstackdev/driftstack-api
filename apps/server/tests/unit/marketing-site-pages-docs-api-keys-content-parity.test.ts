// W516.A — drift guard for apps/marketing-site/src/pages/docs/api-keys.astro.
// V-687 API keys developer docs + W217.B scope-table accuracy pass.
// Drift here either changes a scope (would create marketing↔
// api_key_scope-Postgres-enum divergence) or breaks the ds_live_
// prefix commitment (would mislead about key detection at request parse).
//
//   • V-687 doc-comment framing.
//   • W217.B scope tables pinned to api_key_scope Postgres enum +
//     reserved gui_control + driftstack_internal_admin not shown.
//   • SCOPES: 3-broad-scope ladder (read / write / account_owner).
//   • GRANULAR: 13-granular verb:resource scopes.
//   • Paid ds_live_<random> customer keys + Free desktop ds_test_ device credentials.
//   • Bearer-token auth + rate-limit-headers + /docs/rate-limits.
//   • 90-day rotation hygiene + 4-step rotation flow.
//   • Leak response: revoke + 401 on subsequent + in-flight-keeps-running
//     + audit-log + security@driftstack.dev.
//   • One-key-per-environment + one-key-per-third-party + OAuth delegation.
//   • Nullable actor_key_id surfaces in /v1/account/audit-log.
//   • FAQ: no-plaintext-after-create + multi-region-OK + no-per-resource-scoping.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W516.A apps/marketing-site/src/pages/docs/api-keys.astro content parity', () => {
  const body = read(LIB);

  it("V-687 + W217.B framing pinned: 'API keys developer docs. Minting, scopes, rotation, revocation, what to do when one leaks.' + W217.B scope tables pinned to api_key_scope Postgres enum + reserved (gui_control, driftstack_internal_admin) intentionally not shown — pinned so the V-687 anchor + W217.B api_key_scope-enum-anchor + reserved-scopes-hidden commitments survive (drift to exposing reserved scopes would create marketing↔customer-API divergence)", () => {
    expect(body).toMatch(
      /\/\/ V-687 — API keys developer docs\. Minting, scopes, rotation,\s*\n?\s*\/\/ revocation, what to do when one leaks\./,
    );
    expect(body).toMatch(
      /\/\/ W217\.B — scope tables pinned to the api_key_scope Postgres enum\s*\n?\s*\/\/ \(apps\/server\/src\/db\/schema\.ts\)\. The full enum has more values\s*\n?\s*\/\/ \(gui_control, driftstack_internal_admin\) that are reserved for\s*\n?\s*\/\/ dashboard \+ Driftstack-staff use and are intentionally not shown\s*\n?\s*\/\/ to customer integrators here\./,
    );
  });

  it('3-broad-scope ladder pinned: read (sessions+profiles) + write (mutate sessions+profiles, NOT billing) + account_owner (read-write whole account incl. billing + team management) — pinned so the 3-broad-scope ladder + write-does-NOT-include-billing carve-out + account_owner-billing-team-management commitments survive (drift to claiming write includes billing would expand the implicit-grant beyond customer expectation)', () => {
    expect(body).toMatch(/name: 'read', desc: 'Read sessions and profiles\.'/);
    expect(body).toMatch(
      /name: 'write', desc: 'Mutate sessions and profiles\. Does NOT include billing\.'/,
    );
    expect(body).toMatch(
      /name: 'account_owner', desc: 'Read-write across the whole account, including billing and team management\.'/,
    );
  });

  it('13-granular scope surface pinned: read:sessions + write:sessions + read:profiles + write:profiles + admin:profiles + read:webhooks + write:webhooks + admin:webhooks + read:api-keys + admin:api-keys + read:billing + admin:billing + read:audit — pinned so the 13-verb:resource granular ladder stays consistent with the api_key_scope enum (drift to dropping any granular scope would create marketing↔enum divergence; drift to adding a write:audit or read:api-keys-other-shape would create marketing↔server divergence)', () => {
    expect(body).toMatch(/name: 'read:sessions'/);
    expect(body).toMatch(/name: 'write:sessions'/);
    expect(body).toMatch(/name: 'read:profiles'/);
    expect(body).toMatch(/name: 'write:profiles'/);
    expect(body).toMatch(/name: 'admin:profiles'/);
    expect(body).toMatch(/name: 'read:webhooks'/);
    expect(body).toMatch(/name: 'write:webhooks'/);
    expect(body).toMatch(/name: 'admin:webhooks'/);
    expect(body).toMatch(/name: 'read:api-keys'/);
    expect(body).toMatch(/name: 'admin:api-keys'/);
    expect(body).toMatch(/name: 'read:billing'/);
    expect(body).toMatch(/name: 'admin:billing'/);
    expect(body).toMatch(/name: 'read:audit'/);
  });

  it("Broad-satisfies-granular framing pinned: 'Broad scopes satisfy the corresponding granular scopes on the same verb. A key with read can call any endpoint that requires read:sessions, but a key with only read:sessions cannot call endpoints that require read:profiles.' — pinned so the broad-supersedes-granular + granular-doesn't-cross-resource semantics survives (drift to claiming granular-satisfies-broad would invert the privilege ladder)", () => {
    expect(body).toMatch(
      /Broad scopes satisfy the corresponding granular scopes on the\s*\n?\s*same verb\. A key with <code>read<\/code> can call any endpoint\s*\n?\s*that requires <code>read:sessions<\/code>, but a key with only\s*\n?\s*<code>read:sessions<\/code> cannot call endpoints that require\s*\n?\s*<code>read:profiles<\/code>\./,
    );
  });

  it('paid customer-key + Free desktop-device boundary and hash-only handling are pinned', () => {
    expect(body).toMatch(
      /Customer-key format: <code>ds_live_&lt;random&gt;<\/code>\. The\s*\n?\s*<code>ds_live_<\/code> prefix is how Driftstack detects "this\s*\n?\s*looks like an API key" during request parsing\./,
    );
    expect(body).toContain("You'll see the full plaintext key once —");
    expect(body).toContain(
      'copy it now and store it in your config / secret manager. We only store',
    );
    expect(body).toMatch(/if you lose the plaintext,\s+revoke and mint a new one\./);
    expect(body).toContain('restricted <code>ds_test_…</code> device credential');
    expect(body).toContain('not a customer API key, a general SDK key, or a sandbox credential');
    expect(body).toContain('A Free dashboard web session can list and revoke keys');
    expect(body).toContain('create and rotate return an RFC 9457');
  });

  it("Bearer-token-auth framing pinned: 'Authorization: Bearer ds_live_…' + 'Every authenticated response carries rate-limit headers (see /docs/rate-limits). Watch them; they'll save you a 429 down the line.' — pinned so the Bearer-token + every-response-rate-limit-headers + 429-warning + /docs/rate-limits cross-ref survive", () => {
    expect(body).toMatch(/Authorization: Bearer ds_live_…/);
    expect(body).toMatch(
      /Every authenticated response carries rate-limit headers\s*\n?\s*\(see <a href="\/docs\/rate-limits\/">\/docs\/rate-limits<\/a>\)\.\s*\n?\s*Watch them; they'll save you a 429 down the line\./,
    );
  });

  it('90-day rotation hygiene + last_used_at verification flow pinned', () => {
    expect(body).toMatch(
      /Routine hygiene: rotate any production key at least every 90\s*\n?\s*days\./,
    );
    expect(body).toMatch(/<li>Mint a new key with the same scope set as the old one\.<\/li>/);
    expect(body).toMatch(/<li>Deploy the new key to your environment\.<\/li>/);
    expect(body).toContain("page shows each key's <code>last_used_at</code>");
    expect(body).toMatch(/the\s+successor is active and the old key has stopped advancing/);
    expect(body).toMatch(/<li>Revoke the old key from the dashboard\.<\/li>/);
  });

  it("Leak-response 3-effect framing pinned: subsequent 401 + in-flight session keeps running (session tied to account not key) + revocation logged with actor + timestamp + 'Email security@driftstack.dev if the leak resulted in unauthorized activity — we'll help audit the account.' — pinned so the 3-effect + sessions-survive-revoke-because-tied-to-account + security@ unauthorized-activity escalation path survives", () => {
    expect(body).toMatch(/<li>Subsequent requests with that key return 401\.<\/li>/);
    expect(body).toMatch(
      /Any in-flight session it started keeps running \(sessions\s*\n?\s*are tied to the account, not the key\)\. Stop the session\s*\n?\s*explicitly if you need it gone\./,
    );
    expect(body).toMatch(
      /The revocation is logged in your account audit log with the\s*\n?\s*actor \+ timestamp\./,
    );
    expect(body).toMatch(
      /Email <a href="mailto:security@driftstack\.dev">security@driftstack\.dev<\/a>\s*\n?\s*if the leak resulted in unauthorized activity — we'll help\s*\n?\s*audit the account\./,
    );
  });

  it('key-count guidance distinguishes human dashboard accounts from approved OAuth delegation', () => {
    expect(body).toMatch(
      /<strong>One key per environment<\/strong> \(production,\s*\n?\s*staging, dev\)\. Makes rotation \+ revocation surgical\./,
    );
    expect(body).toMatch(
      /<strong>One key per third-party integration<\/strong> if\s*\n?\s*you're handing keys to other services\. Revoking one\s*\n?\s*integration doesn't take out the others\./,
    );
    expect(body).toContain("Don't share keys across team members. Humans should use their own");
    expect(body).toContain('dashboard account. Use <a href="/docs/oauth-apps/">OAuth</a> when an');
    expect(body).toContain('approved third-party application needs delegated customer access.');
    expect(body).not.toMatch(/href="\/docs\/(?:rate-limits|oauth-apps)"/);
  });

  it('nullable actor_key_id audit metadata and both access paths are pinned', () => {
    expect(body).toContain('An API-key-authenticated audit entry carries the acting');
    expect(body).toContain('<code>actor_key_id</code>');
    expect(body).toContain('<code>actor_key_id: null</code>');
    expect(body).toContain('the public field is not named');
    expect(body).toContain('<code>api_key_id</code>');
    expect(body).toContain('<code>GET /v1/account/audit-log</code>');
  });

  it("FAQ 3-question framing pinned: 'Can I view a key's plaintext after creation?' (No, hash-only) + 'What happens if I use the same key from two regions simultaneously?' (Fine — keys aren't bound to a region. Rate limits are per-account, so the two regions share the bucket budget.) + 'Can I scope a key to a specific session id?' (No, current scopes are verb:resource) — pinned so the 3-FAQ + per-account-rate-limit + current authorization boundary survive", () => {
    expect(body).toMatch(/<dt>Can I view a key's plaintext after creation\?<\/dt>/);
    expect(body).toMatch(
      /<dd>No\. We only store the hash; the plaintext is shown once on\s*\n?\s*creation\./,
    );
    expect(body).toMatch(
      /<dt>What happens if I use the same key from two regions\s*\n?\s*simultaneously\?<\/dt>/,
    );
    expect(body).toMatch(
      /<dd>Fine — keys aren't bound to a region\. Rate limits are\s*\n?\s*per-account, so the two regions share the bucket budget\.<\/dd>/,
    );
    expect(body).toMatch(/<dt>Can I scope a key to a specific session id\?<\/dt>/);
    expect(body).toMatch(
      /<dd>No\. API-key authorization uses verb:resource scopes \(e\.g\.\s*\n?\s*<code>read:sessions<\/code>\)\.<\/dd>/,
    );
    expect(body).not.toMatch(/future-features|not today/i);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
