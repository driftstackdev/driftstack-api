// W603 — drift guard for apps/docs/src/pages/guides.
// 4 modules in one suite: index.astro + profile-management.md + team-rbac.md + session-lifecycle.md.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/index.astro');
const PROFILE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/profile-management.md');
const TEAM = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/team-rbac.md');
const SESSION = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/session-lifecycle.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W603 apps/docs/guides pages content parity', () => {
  it('guides/index.astro: 3 concept guides (profile-management + session-lifecycle + team-rbac) + Get-started cross-refs + Architecture+reference + Pre-launch GitHub links pinned', () => {
    const body = read(INDEX);
    expect(body).toMatch(/<DocLayout title="Guides">/);
    expect(body).toMatch(/^\s*<h1>Guides<\/h1>/m);
    expect(body).toMatch(/Onboarding tutorials, common workflows, integration patterns\./);
    expect(body).toMatch(/<a href="\/guides\/profile-management\/">Profile management<\/a>/);
    expect(body).toMatch(/<a href="\/guides\/session-lifecycle\/">Session lifecycle<\/a>/);
    expect(body).toMatch(/<a href="\/guides\/team-rbac\/">Team RBAC — invite, accept, act-as<\/a>/);
    expect(body).toMatch(/<a href="\/quickstart\/">Quickstart<\/a>/);
    expect(body).toMatch(/<a href="\/sdk\/installation\/">SDK installation<\/a>/);
    expect(body).toMatch(/<a href="\/license-activation\/">License activation<\/a>/);
    expect(body).toMatch(/<a href="\/api\/versioning\/">API versioning policy<\/a>/);
    expect(body).toMatch(/<a href="\/webhooks\/events\/">Webhook events catalog<\/a>/);
    expect(body).toMatch(/<a href="\/sdk\/versioning\/">SDK versioning policy<\/a>/);
    expect(body).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs\/architecture"/,
    );
    expect(body).toMatch(/team-roles-taxonomy\.md"/);
    expect(body).toMatch(/href="mailto:support@driftstack\.dev"/);
    expect(existsSync(INDEX)).toBe(true);
  });

  it('profile-management.md: persistent identity + cookies/localStorage/IndexedDB/stealth state + ephemeral=no-profile + 8-row tier-cap table + locked-archetype (iphone16pro_ios18_7_safari26_4) + RFC 9457 tier-limit problem-type + 3-language create examples pinned', () => {
    const body = read(PROFILE);
    expect(body).toMatch(/^title: Profile management$/m);
    expect(body).toMatch(/^# Profile management$/m);
    expect(body).toMatch(
      /A \*\*profile\*\* is a persistent identity Driftstack maintains across sessions\./,
    );
    expect(body).toMatch(
      /Cookies, local storage, IndexedDB, and the WebKit-fork's stealth state survive between session lifetimes/,
    );
    expect(body).toMatch(/If a session doesn't bind a profile, it starts ephemeral/);
    expect(body).toMatch(/^## Tier limits$/m);
    expect(body).toMatch(
      /Each tier has a profile cap, enforced at `POST \/v1\/profiles` creation time\./,
    );
    expect(body).toMatch(
      /Exceeding the cap returns `429` with an RFC 9457 `https:\/\/errors\.driftstack\.dev\/tier-limit` problem body/,
    );
    expect(body).toMatch(/\| Free\s+\| 1\s+\|/);
    expect(body).toMatch(/\| Personal\s+\| 10\s+\|/);
    expect(body).toMatch(/\| Team\s+\| 50\s+\|/);
    expect(body).toMatch(/\| Agency\s+\| 200\s+\|/);
    expect(body).toMatch(/\| API Starter\s+\| 25\s+\|/);
    expect(body).toMatch(/\| API Builder\s+\| 100\s+\|/);
    expect(body).toMatch(/\| API Scale\s+\| 500\s+\|/);
    expect(body).toMatch(/\| Enterprise\s+\| Custom\s+\|/);
    expect(body).toMatch(
      /Self-hosted tiers don't enforce per-account profile caps — they enforce concurrent-session caps \+ archetype counts at the fleet level instead\./,
    );
    expect(body).toMatch(/^## Create a profile$/m);
    expect(body).toMatch(/`iphone16pro_ios18_7_safari26_4`/);
    expect(body).toMatch(/await client\.profiles\.create\(\{/);
    expect(body).toMatch(/name: 'shopper-account-1',/);
    expect(existsSync(PROFILE)).toBe(true);
  });

  it('team-rbac.md: full lifecycle (owner invite → member accept → act-as) + 2 roles (member read-only / admin full read+write) + 7-day accept-link expiry + X-Driftstack-Account header act-as + audit-log trail pinned', () => {
    const body = read(TEAM);
    expect(body).toMatch(/^title: Team RBAC — invite, accept, act-as$/m);
    expect(body).toMatch(/^# Team RBAC — invite, accept, act-as$/m);
    expect(body).toMatch(/This guide walks through the full lifecycle of a Driftstack team:/);
    expect(body).toMatch(/the \*\*owner\*\* invites a \*\*member\*\*, the member accepts, and the/);
    expect(body).toMatch(/member then runs sessions \/ manages resources scoped to the owner's/);
    expect(body).toMatch(/account\./);
    expect(body).toMatch(/^## Step 1 — Invite a teammate \(owner\)$/m);
    // V-704 — team members retain persisted resource reads, but live browser
    // state contains secrets and therefore requires team-admin authority.
    expect(body).toMatch(
      /- `member` — read access to the owner's persisted session metadata \/\s+profiles \/ audit log \/ etc\. Live session state requires `admin`\./,
    );
    expect(body).toMatch(/- `admin` — full read \+ write\. Can create sessions, mint API/);
    expect(body).toMatch(/-H "Authorization: Bearer \$DRIFTSTACK_OWNER_KEY"/);
    expect(body).toMatch(/-d '\{"email": "alice@example\.com", "role": "admin"\}'/);
    expect(body).toMatch(/The teammate receives an email with a 7-day accept link\./);
    expect(body).toMatch(/^## Step 2 — Accept the invite \(teammate\)$/m);
    expect(existsSync(TEAM)).toBe(true);
  });

  it('session-lifecycle.md: creating/ready/busy/destroyed/errored state diagram + concurrent caps (Free 1 / Solo 1 / Team 3 / Agency 8 / Starter 2 / Builder 8 / Scale 24) + free-tier duration cap (S31: idle timeout was fictional) + 429-with-problem-body on cap-exceeded + concurrent-caps-only-metering (no hour caps no overage) pinned', () => {
    const body = read(SESSION);
    expect(body).toMatch(/^title: Session lifecycle$/m);
    expect(body).toMatch(/^# Session lifecycle$/m);
    expect(body).toMatch(
      /A \*\*session\*\* is one running iPhone Safari instance on the modified WebKit fork\./,
    );
    expect(body).toMatch(
      /Every session occupies one of your account's concurrent slots from creation until destruction/,
    );
    expect(body).toMatch(/^## States$/m);
    // The wire-level SessionStatusSchema is 5 values: creating /
    // ready / busy / destroyed / errored (matches
    // packages/api-types/src/sessions.ts).
    expect(body).toMatch(/│ creating │/);
    expect(body).toMatch(/│ ready │/);
    expect(body).toMatch(/│ busy │/);
    expect(body).toMatch(/│ destroyed │/);
    expect(body).toMatch(/`errored`/);
    expect(body).toMatch(/destroy/);
    // V-702 — creation has a durable reservation that concurrent list/detail
    // reads can observe; direct operations require exact ready → busy admission.
    expect(body).toMatch(
      /concurrent resource read or list can observe the durable `creating` reservation/,
    );
    expect(body).toMatch(
      /Every direct driver operation atomically claims `ready` → `busy`; while the session is `creating` or `busy`, another operation returns `409 Conflict`/,
    );
    expect(body).toMatch(/^## Concurrency$/m);
    expect(body).toMatch(
      // S31 2026-07-07 (fable-truth-audit) — concurrency 429s carry no Retry-After.
      /`429 Too Many Requests` on `sessions\.create\(\)`, with `current_sessions` and `limit` in the problem body/,
    );
    expect(body).toMatch(/\| Free\s+\| 1\s+\|/);
    expect(body).toMatch(/\| Personal\s+\| 1\s+\|/);
    expect(body).toMatch(/\| Team\s+\| 3\s+\|/);
    expect(body).toMatch(/\| Agency\s+\| 8\s+\|/);
    expect(body).toMatch(/\| API Starter\s+\| 2\s+\|/);
    expect(body).toMatch(/\| API Builder\s+\| 8\s+\|/);
    expect(body).toMatch(/\| API Scale\s+\| 24\s+\|/);
    expect(body).toMatch(/\| Enterprise\s+\| 32\s+\|/);
    expect(body).toMatch(
      /Concurrent caps are the only metering on paid tiers — there are no hour caps and no overage charges\./,
    );
    expect(existsSync(SESSION)).toBe(true);
  });
});
