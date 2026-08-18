// W571.C — drift guard for /docs/progress/tuesday-pickup.md.
// Tuesday-resume pickup queue paused per cost-discipline 2026-05-09.
// Drift here either re-orders the priority queue 1-9, drops a
// founder-direction-required item (V-413 + account-deletion +
// per-tier-gating + Stripe-keys + NowPayments + LiveKit + comms),
// or unsets the Rule-M (≥2 P-track parallel) / Rule-K (NEVER STOP) /
// 15-25 slices / 8h memory throughput.
//
//   • Paused 2026-05-09 per founder cost-discipline.
//   • Resume condition: Tuesday weekly token reset.
//   • F-001 mobile UI + F-003 OAuth gated on founder details.
//   • Queue items 1-9 (F-001, F-003, V-294 cont, V-278.J-2, V-278.K,
//     V-278.L, apps/docs gaps, test coverage, PLANNING-INDEX.md).
//   • 7 items NOT to pick up without founder direction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/progress/tuesday-pickup.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W571.C /docs/progress/tuesday-pickup.md content parity', () => {
  const body = read(LIB);

  it('Header + paused-2026-05-09 + cost-discipline + Tuesday-reset + Rule-M + Rule-K + 15-25 slices framing pinned', () => {
    expect(body).toMatch(/^# Tuesday pickup queue$/m);
    expect(body).toMatch(/\*\*Last updated:\*\* 2026-05-09 \(paused per founder cost-discipline\)/);
    expect(body).toMatch(
      /\*\*Resume condition:\*\* founder explicit reactivation Tuesday \(weekly/,
    );
    expect(body).toMatch(/token reset\)\./);
    expect(body).toMatch(/Per Rule M minimum 2 P-track parallel slices on resume; per Rule K/);
    expect(body).toMatch(/NEVER STOP once reactivated\. Per memory #18 sustained throughput/);
    expect(body).toMatch(/target 15-25 slices \/ 8h\./);
  });

  it('Queue items 1-4 (F-001 + F-003 + V-294 + V-278.J-2) framing pinned', () => {
    expect(body).toMatch(/### 1\. F-001 — Mobile UI bug/);
    expect(body).toMatch(/\*\*Awaits:\*\* founder repro details \(device \+ URL \+ screenshot\)\./);
    expect(body).toMatch(/Frontend issue\. Surface unclear \(marketing \/ dashboard \/ docs\?\)\./);
    expect(body).toMatch(/Once details land, reproduce locally via Astro dev server \+/);
    expect(body).toMatch(/mobile-viewport browser devtools, fix, redeploy via wrangler\./);
    expect(body).toMatch(/Likely/);
    expect(body).toMatch(/candidates: tailwind responsive breakpoints, fixed-width sidebars,/);
    expect(body).toMatch(/overflow-x on long URL strings, signup form layout\./);
    expect(body).toMatch(/### 2\. F-003 — OAuth \(Google \+ GitHub\) signup \+ signin/);
    expect(body).toMatch(/\*\*Awaits:\*\* founder registers OAuth apps \+ supplies Client IDs \+/);
    expect(body).toMatch(/Secrets\. Callback URL pattern:/);
    expect(body).toMatch(
      /`https:\/\/api\.driftstack\.dev\/v1\/auth\/oauth\/<provider>\/callback`\./,
    );
    expect(body).toMatch(/\*\*Engineering scope \(~6h\):\*\*/);
    expect(body).toMatch(/- `apps\/server\/src\/lib\/config\.ts` — `GOOGLE_OAUTH_CLIENT_ID` \+/);
    expect(body).toMatch(/`_SECRET`; `GITHUB_OAUTH_CLIENT_ID` \+ `_SECRET`\./);
    expect(body).toMatch(
      /- `POST \/v1\/auth\/oauth\/<provider>\/initiate` \(returns redirect URL \+/,
    );
    expect(body).toMatch(/state nonce stored in Redis with 5-min TTL\)\./);
    expect(body).toMatch(
      /- `GET \/v1\/auth\/oauth\/<provider>\/callback` \(consumes code, exchanges/,
    );
    expect(body).toMatch(/with provider, mints account if new email \/ signs in if existing\)\./);
    expect(body).toMatch(/- Provider handlers via `arctic` \(modern lightweight OAuth lib; no/);
    expect(body).toMatch(/Passport bloat\)\./);
    expect(body).toMatch(/- Account-lifecycle integration — OAuth-signups skip the/);
    expect(body).toMatch(/email-verification step \(provider already verified the email\)\./);
    expect(body).toMatch(
      /- Audit-log entries: `account\.oauth_linked`, `account\.oauth_signed_in`\./,
    );
    expect(body).toMatch(/- Sub-processor disclosure update: Google \+ GitHub for the OAuth/);
    expect(body).toMatch(/handshake \(auth identifier only; no customer-data flow\)\./);
    expect(body).toMatch(/Add to/);
    expect(body).toMatch(/DPA Annex 3 \+ sub-processors\.ts\./);
    expect(body).toMatch(/### 3\. V-294 catalog continuation/);
    expect(body).toMatch(/Per the locked priority order in/);
    expect(body).toMatch(/`docs\/architecture\/v294-feature-catalog\.md`\./);
    expect(body).toMatch(/- \*\*V-312 finish\*\* — restore-from-snapshot UX flow polish\./);
    expect(body).toMatch(/- \*\*V-313 finish\*\* — clone history visualization\./);
    expect(body).toMatch(
      /- \*\*V-298b\*\* — region selection deepening \(pricing\/billing surfaces\)\./,
    );
    expect(body).toMatch(/- \*\*V-353 polish\*\* — MFA cycle UX; recovery-code-regenerate/);
    expect(body).toMatch(/confirmation, post-disable banner\./);
    expect(body).toMatch(/- \*\*Account deletion full flow\*\* — GDPR Article 17\./);
    expect(body).toMatch(
      /\*\*SURFACE-AS-BLOCKING\*\* — touches retention windows; founder verdict/,
    );
    expect(body).toMatch(/needed on hard-delete vs soft-delete \+ retention duration\./);
    expect(body).toMatch(/- \*\*Per-tier feature gating\*\* — pricing-tied; surface-as-blocking\./);
    expect(body).toMatch(/- \*\*Stripe portal deepening\*\* — billing-tied; surface-as-blocking/);
    expect(body).toMatch(/\(live keys gated on KvK; landing post-2026-05-21\)\./);
    expect(body).toMatch(/### 4\. V-278\.J-2 — Per-service Sentry projects/);
    expect(body).toMatch(/\*\*Scope:\*\* create dedicated `driftstack-dashboard` \+/);
    expect(body).toMatch(/`driftstack-marketing` Sentry projects via the org auth token API\./);
    expect(body).toMatch(/Wire DSNs into the Astro builds \(`PUBLIC_SENTRY_DSN_DASHBOARD` \//);
    expect(body).toMatch(/`_MARKETING`\); Astro's `@sentry\/astro` integration captures errors at/);
    expect(body).toMatch(/the Pages-Worker layer\./);
    expect(body).toMatch(/Current Sentry org token's scopes appear release-only; may need/);
    expect(body).toMatch(/re-issue with `project:write`\./);
  });

  it('Queue items 5-9 (V-278.K + V-278.L + apps/docs + test coverage + PLANNING-INDEX) + NOT-to-pick-up + Pre-resume sanity checks framing pinned', () => {
    expect(body).toMatch(/### 5\. V-278\.K — Neon prod \+ staging split/);
    expect(body).toMatch(
      /\*\*Scope:\*\* create a separate Neon project for staging \(or branch the/,
    );
    expect(body).toMatch(/current production project; Neon's branching is the cleanest path\)\./);
    expect(body).toMatch(/Update `staging\.env` to point at the new connection string\./);
    expect(body).toMatch(/### 6\. V-278\.L — Upstash prod \+ staging split/);
    expect(body).toMatch(/\*\*Scope:\*\* create separate Upstash database for staging\./);
    expect(body).toMatch(/Update/);
    expect(body).toMatch(/`staging\.env` UPSTASH_REDIS_REST_URL \+ REDIS_URL accordingly\./);
    expect(body).toMatch(/Drop/);
    expect(body).toMatch(/the `stg:` key prefix in favour of physical isolation\./);
    expect(body).toMatch(/### 7\. Apps\/docs gaps/);
    expect(body).toMatch(/- \*\*Marketing comparison page\*\* — vs Browserless \/ Bright Data \//);
    expect(body).toMatch(/ScrapingBee \/ Browserbase\./);
    expect(body).toMatch(/- \*\*Public roadmap\*\* — `\/roadmap\.astro` doesn't exist\./);
    expect(body).toMatch(/Source from/);
    expect(body).toMatch(/V-294 catalog selectively \(don't expose internal V-NNN tags\)\./);
    expect(body).toMatch(/- \*\*Status page indicator\*\* — small badge on marketing showing/);
    expect(body).toMatch(/current platform status \(driftstack\.dev fetches/);
    expect(body).toMatch(/api\.driftstack\.dev\/v1\/status\)\./);
    expect(body).toMatch(/- \*\*Onboarding flow polish\*\* — welcome → trial-pack → first-key →/);
    expect(body).toMatch(/first-session ergonomics review\./);
    expect(body).toMatch(
      /- \*\*Trust center additions\*\* — `\/trust\/security`, `\/trust\/compliance`,/,
    );
    expect(body).toMatch(/`\/trust\/incidents` carved from existing `\/security\.astro` content\./);
    expect(body).toMatch(/### 8\. Test coverage extension/);
    expect(body).toMatch(/- V-298b region preference roundtrip \(server \+ 3-SDK\)\./);
    expect(body).toMatch(
      /- V-312 snapshot capture-then-restore happy path \+ tier-cap collision\./,
    );
    expect(body).toMatch(/- V-313 clone naming auto-derivation\./);
    expect(body).toMatch(/- V-353 MFA enroll\/verify\/disable lifecycle\./);
    expect(body).toMatch(/- V-359 webhook secret rotation grace window \(24h dual-sign\)\./);
    expect(body).toMatch(/- Cross-SDK regression for the V-455 closure additions \(currently/);
    expect(body).toMatch(/TS-only edge cases; mirror in Python \+ Go\)\./);
    expect(body).toMatch(/### 9\. PLANNING-INDEX\.md continuation/);
    expect(body).toMatch(/Per memory rule #12: when V-294 catalog saturates, consult/);
    expect(body).toMatch(/`\/mnt\/project\/PLANNING-INDEX\.md` \(118 planning files\)\./);
    expect(body).toMatch(/The catalog is/);
    expect(body).toMatch(/~50% saturated; expect this to land mid-Tuesday session\./);
    expect(body).toMatch(/## Items NOT to pick up without founder direction/);
    expect(body).toMatch(
      /~~\*\*V-413\*\* — Tier-3 IP\/UA leak in account-audit payloads \(security/,
    );
    expect(body).toMatch(/architecture; verdict pending\)\.~~ \*\*SHIPPED\*\*/);
    // V-827 SENTINEL — the gate must not read as open again. The scrub is in
    // routes/account-audit.ts; nothing is waiting on a decision.
    expect(body, 'no verdict is pending on the audit-privacy scrub').not.toMatch(
      /architecture; founder verdict pending\)\.\s*$/m,
    );
    expect(body).toMatch(
      /- \*\*Account deletion retention\*\* \(touches legal retention periods\)\./,
    );
    expect(body).toMatch(
      /- \*\*Per-tier feature gating\*\* \+ \*\*pricing details\*\* \(touches pricing\)\./,
    );
    expect(body).toMatch(
      /- \*\*Live Stripe keys\*\* \+ \*\*Stripe webhook secret\*\* \(touches commercial/,
    );
    expect(body).toMatch(/activation; gated on BV KvK closure ~2026-05-21\)\./);
    expect(body).toMatch(/~~\*\*NowPayments \/ crypto rail\*\* — ADR-002 deferred; provider not/);

    // V-827 — the banner and both SHIPPED markers are what stop this snapshot
    // being read as current state. The struck-through text stays pinned: it is
    // the record of what the gate said, and deleting it would lose why anyone
    // avoided these subsystems.
    expect(body).toMatch(/⚠ SUPERSEDED — this is a snapshot of 2026-05-09, not current state\./);
    expect(body, 'the audit-privacy scrub shipped').toMatch(
      /\*\*SHIPPED\*\* — `routes\/account-audit\.ts`/,
    );
    expect(body, 'the crypto rail shipped').toMatch(
      /\*\*SHIPPED\*\* — five `\/v1\/billing\/crypto-\*` routes are registered/,
    );
    expect(body).toMatch(/chosen\./);
    expect(body).toMatch(/- \*\*LiveKit\*\* — Agent 1 territory\./);
    expect(body).toMatch(/- \*\*Organic growth \/ paid acquisition \/ launch comms\*\* — out of/);
    expect(body).toMatch(/Agent 2 scope\./);
    expect(body).toMatch(/## Pre-resume sanity checks \(Tuesday\)/);
    expect(body).toMatch(/git -C \/Users\/john\/code\/driftstack-api log -1 --oneline/);
    expect(body).toMatch(/git -C \/Users\/john\/code\/driftstack-api status --short/);
    expect(body).toMatch(/npm run typecheck && npm run lint && npm run format:check && npm test/);
    expect(body).toMatch(
      /ssh -o BatchMode=yes root@128\.140\.37\.74 'systemctl is-active driftstack-api'/,
    );
    expect(body).toMatch(
      /ssh -o BatchMode=yes root@116\.203\.22\.197 'systemctl is-active driftstack-api'/,
    );
    expect(body).toMatch(
      /curl -sS -o \/dev\/null -w "%\{http_code\}\\n" https:\/\/api\.driftstack\.dev\/health/,
    );
    expect(body).toMatch(
      /curl -sS -o \/dev\/null -w "%\{http_code\}\\n" https:\/\/app\.driftstack\.dev\//,
    );
    expect(body).toMatch(/Expect: 1169\+\/1169\+ tests pass, both systemd services `active`, both/);
    expect(body).toMatch(/URLs `200`\. If anything regresses overnight, surface to founder before/);
    expect(body).toMatch(/picking up the queue\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
