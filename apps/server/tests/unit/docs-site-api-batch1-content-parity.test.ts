// W605 — drift guard for apps/docs/src/pages/api batch 1.
// 8 modules: index + versioning + sessions + profiles + profile-snapshots + api-keys + account + auth.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const P = (rel: string) => resolve(REPO_ROOT, `apps/docs/src/pages/api/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W605 apps/docs/api batch 1 (8 modules) content parity', () => {
  it('api/index.astro: doc-tree catalogue (12 endpoint links + cross-refs to /quickstart/ + /guides/* + webhooks/events/replay) + OpenAPI Scalar /docs/ render + Bearer auth + ds_live_/ds_test_ key prefixes + 429 retry-after pinned', () => {
    const body = read(P('index.astro'));
    expect(body).toMatch(/<DocLayout title="API reference">/);
    expect(body).toMatch(/<code>https:\/\/api\.driftstack\.dev<\/code>/);
    expect(body).toMatch(/Every/);
    expect(body).toMatch(/endpoint is versioned under <code>\/v1\/\*<\/code>;/);
    expect(body).toMatch(/<a href="\/api\/auth\/">Authentication flows<\/a>/);
    expect(body).toMatch(/<a href="\/api\/account\/">Account<\/a>/);
    expect(body).toMatch(/<a href="\/api\/api-keys\/">API keys<\/a>/);
    expect(body).toMatch(/<a href="\/api\/sessions\/">Sessions<\/a>/);
    expect(body).toMatch(/<a href="\/api\/profiles\/">Profiles<\/a>/);
    expect(body).toMatch(/<a href="\/api\/usage\/">Usage<\/a>/);
    expect(body).toMatch(/<a href="\/api\/audit-log\/">Audit log<\/a>/);
    expect(body).toMatch(/<a href="\/api\/mfa\/">Two-factor authentication<\/a>/);
    expect(body).toMatch(/<a href="\/api\/billing\/">Billing<\/a>/);
    expect(body).toMatch(/<a href="\/api\/team\/">Team RBAC<\/a>/);
    expect(body).toMatch(/<a href="\/api\/versioning\/">Versioning policy<\/a>/);
    expect(body).toMatch(/<code>https:\/\/api\.driftstack\.dev\/openapi\.json<\/code>;/);
    expect(body).toMatch(/rendered via Scalar UI on the API host at <code>\/docs\/<\/code>\./);
    // `ds_test_…` is the restricted desktop device credential, not a general
    // free-tier sandbox key — pinning the old "for the free tier" phrasing
    // would re-assert a sandbox surface the product does not offer.
    expect(body).toMatch(
      /Customer API keys are <code>ds_live_…<\/code> on every\s*\n?\s*paid tier, including Manual\./,
    );
    expect(body).toMatch(
      /<code>ds_test_…<\/code> device credential automatically; it is not a general sandbox key\./,
    );
    expect(body).toMatch(/x-ratelimit-remaining/);
    expect(body).toMatch(/<code>retry-after<\/code>/);
    expect(existsSync(P('index.astro'))).toBe(true);
  });

  it('versioning.md: HTTP API /v1→/v2 vs SDK versioning split + additive-vs-breaking + deprecation cycle pinned', () => {
    const body = read(P('versioning.md'));
    expect(body).toMatch(/^title: API versioning policy$/m);
    expect(body).toMatch(/^# API versioning strategy$/m);
    expect(body).toMatch(/Versioning policy for the HTTP API surface \(`\/v1\/\*` and any later/);
    expect(body).toMatch(/major prefix\)\./);
    expect(body).toMatch(/Distinct from the SDK versioning policy at/);
    expect(existsSync(P('versioning.md'))).toBe(true);
  });

  it('sessions.md: iPhone Safari WebKit-fork session + concurrent-slot framing + 8-row TIER_CONCURRENT_SESSION_LIMITS table + 429-problem-body on cap-exceeded + free-tier duration cap (S31: idle timeout was fictional) pinned', () => {
    const body = read(P('sessions.md'));
    expect(body).toMatch(/^title: Sessions$/m);
    expect(body).toMatch(/^# Sessions$/m);
    expect(body).toMatch(/A \*\*session\*\* is one running iPhone Safari instance on the modified/);
    expect(body).toMatch(/WebKit fork, occupying one of your account's concurrent slots/);
    expect(body).toMatch(/^## Concurrency$/m);
    expect(body).toMatch(/`TIER_CONCURRENT_SESSION_LIMITS` constant in/);
    expect(body).toMatch(/`@driftstack\/api-types`/);
    expect(body).toMatch(/\| `free`\s+\|\s+1 \|/);
    expect(body).toMatch(/\| `api_scale`\s+\|\s+24 \|/);
    expect(body).toMatch(/\| `enterprise`\s+\|\s+32 \|/);
    expect(body).toMatch(/Hitting the cap on `POST \/v1\/sessions` returns `429 Too Many/);
    // S31 2026-07-07 (fable-truth-audit) — concurrency 429 carries no Retry-After (only
    // rate-limit 429s do).
    expect(body).toMatch(/Requests` with `current_sessions` and `limit` in the problem body/);
    // S31 2026-07-07 (fable-truth-audit) — no idle timeout; the real boundary is the
    // free-tier duration cap.
    expect(body).toMatch(/free-tier sessions stop at the 20-minute duration/);
    expect(body).not.toMatch(/tier-default idle timeout/); // S31 2026-07-07 (fable-truth-audit)
    expect(existsSync(P('sessions.md'))).toBe(true);
  });

  it('profiles.md: named persistent browser identity + cookies/localStorage/IndexedDB inheritance + tier-cap-on-create+clone + V-313 clone auto-derived name pinned', () => {
    const body = read(P('profiles.md'));
    expect(body).toMatch(/^title: Profiles$/m);
    expect(body).toMatch(/^# Profiles$/m);
    expect(body).toMatch(/A \*\*profile\*\* is a named, persistent browser identity Driftstack/);
    expect(body).toMatch(/remembers between sessions\./);
    expect(body).toMatch(/Cookies, `localStorage`, `IndexedDB`,/);
    expect(existsSync(P('profiles.md'))).toBe(true);
  });

  it('profile-snapshots.md: immutable point-in-time copy of saved profile + frozen-while-source-evolves + capture/list/restore/delete verbs pinned. The previous skip pinned inline `V-511 reference.` prefix that was removed from the customer-facing docs as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.dev pages); the framing itself survives without it.', () => {
    const body = read(P('profile-snapshots.md'));
    expect(body).toMatch(/^title: Profile snapshots$/m);
    expect(body).toMatch(/^# Profile snapshots$/m);
    expect(body).toMatch(/A \*\*profile snapshot\*\* is an immutable/);
    // S36 2026-07-07 (fable-truth-audit): "copy" → metadata record — v1
    // snapshots capture archetype/name/description only, never browser state.
    expect(body).toMatch(/point-in-time record of a saved profile's \*\*metadata\*\*/);
    expect(body).toMatch(/\*\*What a snapshot does NOT capture at v1: browser state\.\*\*/);
    expect(existsSync(P('profile-snapshots.md'))).toBe(true);
    // Internal V-anchor must NOT bleed into customer-facing docs copy.
    expect(body).not.toMatch(/V-511 reference\./);
  });

  it('api-keys.md: Bearer-token Authorization header + Authorization: Bearer <key> + create/list/rotate/revoke verbs (V-296 24h rotate grace) pinned', () => {
    const body = read(P('api-keys.md'));
    expect(body).toMatch(/^title: API keys$/m);
    expect(body).toMatch(/^# API keys$/m);
    expect(body).toMatch(/Driftstack uses bearer-token authentication\./);
    expect(body).toMatch(/Every API request includes/);
    expect(body).toMatch(/`Authorization: Bearer <key>`\./);
    expect(body).toMatch(/Keys are issued, listed, rotated, and/);
    expect(existsSync(P('api-keys.md'))).toBe(true);
  });

  it('account.md: /v1/account/me self-edit surface + bearer-auth + V-298a slug + V-298b region + V-352b avatar + team-RBAC-immune (never honours X-Driftstack-Account) pinned', () => {
    const body = read(P('account.md'));
    expect(body).toMatch(/^title: Account$/m);
    expect(body).toMatch(/^# Account$/m);
    expect(body).toMatch(
      /The exact `\/v1\/account\/me` identity resource is the calling\s+account's self-edit surface\./,
    );
    // Scoped, not blanket — the nested organization resource is an explicit
    // exception since `98d767a73`.
    expect(body).toMatch(/profile-taxonomy resource is an\s+explicit exception/);
    expect(body).toMatch(/The/);
    expect(body).toMatch(
      /It is bearer-authenticated and never\s+honours the team-RBAC `X-Driftstack-Account` header/,
    );
    expect(existsSync(P('account.md'))).toBe(true);
  });

  it('auth.md: 3 auth surfaces — API-key bearer for SDK consumers, web-session auth for the dashboard, and browser-authorized desktop device credentials. The desktop credential is a third surface with its own restricted `ds_test_…` key, so pinning the superseded two-surface count would hide it from the page contract.', () => {
    const body = read(P('auth.md'));
    expect(body).toMatch(/^title: Authentication flows$/m);
    expect(body).toMatch(/^# Authentication flows$/m);
    expect(body).toMatch(/Driftstack has three auth surfaces:/);
    expect(body).toMatch(/\*\*Customer API-key bearer auth\*\*/);
    expect(body).toMatch(/\*\*Web-session auth\*\*/);
    expect(body).toMatch(/\*\*Browser-authorized device credentials\*\*/);
    expect(existsSync(P('auth.md'))).toBe(true);
  });
});
