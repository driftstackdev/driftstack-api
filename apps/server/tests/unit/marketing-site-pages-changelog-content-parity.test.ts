// W499.A — drift guard for apps/marketing-site/src/pages/changelog.astro.
// Public changelog landing page. Drift here either drops the
// 6-category enum (would render category badges with no styling) or
// re-introduces engineering-internal V-NNN tags (which rotate fast
// and confuse customers).
//
//   • Hand-authored customer-facing entries.
//   • ChangelogEntry 6-category enum: launch / sdk / docs / security /
//     pricing / self-hosted.
//   • CATEGORY_COLOR 6-entry styling map.
//   • Hero 'What changed.' framing.
//   • 2026-05-09 launch entries: profile snapshots / region
//     preference / MFA / webhook rotation / sign-ins / avatars +
//     slug / test deliveries / clone + filter.
//   • 2026-05-08 entries: Team RBAC X-Driftstack-Account / Playwright
//     driver / SDK team+rotate+replay / status page / GDPR Article 20
//     export.
//   • 2026-05-03 pricing: 2-ladder; 2026-05-22 crypto launch.
//   • Subscribe banner: mailto:hello@driftstack.dev + 'roughly one
//     email every 2-4 weeks'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/changelog.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W499.A apps/marketing-site/src/pages/changelog.astro content parity', () => {
  const body = read(LIB);

  it('pins the changelog as hand-authored customer-facing release highlights without an aspirational generator contract', () => {
    expect(body).toMatch(
      /\/\/ Entries below are hand-authored highlights of customer-facing changes\./,
    );
    expect(body).not.toMatch(/placeholder|becomes a build-time generator|once .* stabiliz/i);
  });

  it('historical proxy entries distinguish saved-proxy agent sessions from unsupported direct raw proxy data', () => {
    expect(body).toMatch(/Pass an owned saved proxy_id when creating an agent session/);
    expect(body).toMatch(
      /direct \/v1\/sessions and \/v1\/profiles\/:id\/launch verbs do not accept raw proxy data/,
    );
    expect(body).toMatch(/SESSION_PROXY_REQUIRED=false keeps proxy-free direct creation available/);
    expect(body).toMatch(/raw proxy key is rejected, never treated as proof of egress/);
    expect(body).not.toMatch(/Pass proxy_id when creating a session/);
  });

  it("ChangelogEntry 6-category enum: launch / sdk / docs / security / pricing / self-hosted — pinned so the category taxonomy stays 6-state (drift to dropping any would render an entry with TypeScript's never type; drift to adding new would create an entry the CATEGORY_COLOR map doesn't cover, rendering with no styling)", () => {
    expect(body).toMatch(
      /category: 'launch' \| 'sdk' \| 'docs' \| 'security' \| 'pricing' \| 'self-hosted';/,
    );
  });

  it('CATEGORY_COLOR 6-entry styling map: launch accent / sdk raised-ink / docs raised-ink / security red-100/900 / pricing amber-100/900 / self-hosted emerald-100/900 — pinned so every category resolves to a real badge color. S20 2026-07-06: the pricing chip completed the -900 correction its siblings got — it still used text-tk-accent-soft (the 13%-alpha WASH token misused as a text color; rendered 1.21:1, effectively invisible).', () => {
    expect(body).toMatch(
      /const CATEGORY_COLOR: Record<ChangelogEntry\['category'\], string> = \{\s*\n?\s*launch: 'bg-tk-accent text-white',\s*\n?\s*(?:\s*\/\/[^\n]*)*\s*sdk: 'border border-tk-border bg-tk-raised text-tk-ink',\s*\n?\s*docs: 'border border-tk-border bg-tk-raised text-tk-ink',\s*\n?\s*security: 'bg-red-100 text-red-900',\s*\n?\s*(?:\s*\/\/[^\n]*)*\s*pricing: 'bg-amber-100 text-amber-900',\s*\n?\s*'self-hosted': 'bg-emerald-100 text-emerald-900',\s*\n?\s*\};/,
    );
  });

  it("Hero framing: 'What changed.' heading + 'Customer-facing changes, in reverse-chronological order. SDK releases, pricing changes, security posture updates, self-hosted-tier adjustments. Engineering-internal changes (refactors, test fixtures, observability work) live in the verification log inside the repo, not here.' — pinned so the customer-facing-only scope + the engineering-internal exclusion both survive (drift to including engineering-internal would clutter the changelog with noise customers don't care about)", () => {
    expect(body).toMatch(/What changed\./);
    expect(body).toMatch(
      // S20c 2026-07-06: same scope exclusion, plain words lead.
      /Customer-facing changes, in reverse-chronological order\. SDK\s+releases, pricing changes, security posture updates,\s+self-hosted-tier adjustments\. Internal engineering changes\s+\(code restructuring, test tooling, monitoring work\) are\s+tracked in our internal logs, not here\./,
    );
  });

  it("2026-05-09 'Profile snapshots: immutable point-in-time copies' launch entry — pinned so the snapshot launch announcement + the canonical 'frozen / restore counts against tier cap' framing + the docs.driftstack.dev/api/profiles reference all survive (drift to dropping would orphan customers reading the changelog for the V-375 snapshot feature)", () => {
    expect(body).toMatch(/title: 'Profile snapshots: immutable point-in-time copies',/);
    expect(body).toMatch(
      /Snapshots are frozen — the source profile keeps evolving but the snapshot does not\./,
    );
  });

  it("2026-05-09 'Two-factor authentication (TOTP) is live' security entry: 10 single-use recovery codes + 6-digit code + 15-minute step-up window + docs.driftstack.dev/api/mfa — pinned so the MFA launch surfaces the canonical numbers (10 codes / 6 digits / 15-min step-up) that customers reading from the changelog will compare against the live settings UI", () => {
    expect(body).toMatch(/Two-factor authentication \(TOTP\) is live/);
    expect(body).toMatch(/store your 10 single-use recovery codes/);
    expect(body).toMatch(/15-minute step-up window/);
    expect(body).toMatch(/docs\.driftstack\.dev\/api\/mfa/);
  });

  it("2026-05-09 'Webhook signing-secret rotation with 24-hour grace' security entry: dual-signing during grace folded into the single x-driftstack-signature header as two v1= entries + TypeScript/Python/Go SDK verifiers check every v1= — pinned so the 24h grace + compound-single-header rotation contract + the 3-language SDK verifier reference all survive (drift to claiming a separate prev header would let customers read a never-sent header during rotation)", () => {
    expect(body).toMatch(/Webhook signing-secret rotation with 24-hour grace/);
    expect(body).toMatch(/single x-driftstack-signature header \(t=…,v1=<new>,v1=<old>\)/);
    expect(body).toMatch(/SDK verifiers in TypeScript, Python, and Go check every v1= entry/);
  });

  it("2026-05-08 'Team RBAC end-to-end' security entry: X-Driftstack-Account header + member-vs-admin role asymmetry + 'Acting as' picker — pinned so the team-RBAC launch announcement covers the canonical mechanic (act-as header) AND the role-gating (member reads / admin writes) which customers reading the changelog will compare against the dashboard's Acting-as sidebar widget", () => {
    expect(body).toMatch(
      /A member of a team can scope any \/v1\/\* request to the owner\\'s resources by passing the X-Driftstack-Account header\./,
    );
    expect(body).toMatch(
      /Read endpoints accept both member and admin roles; write endpoints \(POST\/PATCH\/DELETE\/api-keys rotate\) require admin role\./,
    );
  });

  it("2026-05-08 'GDPR Article 20 portability — full audit log export' security entry + 10K-row ceiling — pinned so the explicit Article 20 reference + the 10K cap stay consistent with the customer-dashboard audit-log page's framing (drift to dropping Article 20 reference would break the compliance-documentation traceability)", () => {
    expect(body).toMatch(/GDPR Article 20 portability — full audit log export/);
    expect(body).toMatch(/10K-row ceiling per export with cursor pagination beyond\./);
  });

  it("2026-05-03 'Two-ladder pricing live' entry: Manual ($79 Solo / $249 Team / $699 Agency) + API ($149 Starter / $499 Builder / $1,499 Scale + Enterprise) + free entry tier below both ladders — pinned so the canonical pricing structure stays consistent with the customer-dashboard select-tier and the marketing-site pricing pages (drift would create cross-page price-point divergence)", () => {
    expect(body).toMatch(
      /Manual \(\$79\/mo Solo \/ \$249\/mo Team \/ \$699\/mo Agency\) and API \(\$149\/mo Starter \/ \$499\/mo Builder \/ \$1,499\/mo Scale \+ custom Enterprise\)\. A free entry tier sits below both ladders\./,
    );
  });

  it("2026-05-27 'Perpetual free tier replaces the one-time trial pack' pricing entry — pinned so the founder-locked free-tier replacement announcement survives (drift would re-introduce the retired trial-pack copy)", () => {
    expect(body).toMatch(/title: 'Perpetual free tier replaces the one-time trial pack',/);
    expect(body).toMatch(/The entry tier is now a perpetual free tier: \$0 forever/);
    expect(body).toMatch(/This replaces the previous one-time \$2\.99 trial pack entirely\./);
  });

  it("2026-05-22 'Crypto checkout is live via NowPayments' entry pins the current payment and webhook contract", () => {
    expect(body).toMatch(/title: 'Crypto checkout is live via NowPayments'/);
    expect(body).toMatch(/BTC, LTC, USDT, USDC, ETH, or XMR through NowPayments/);
    expect(body).toMatch(
      /crypto\.order\.paid and crypto\.order\.failed are emitted and subscribable/,
    );
    expect(body).not.toMatch(
      /deferred to post-launch|re-evaluates against actual transaction volume/,
    );
  });

  it("Subscribe banner pinned: 'Want changelog entries delivered?' + mailto:hello@driftstack.dev?subject=Changelog%20subscribe + 'Roughly one email every 2-4 weeks; only material changes (no internal-noise spam).' — pinned so the subscribe path + the 2-4 weeks cadence + the no-spam pledge all survive (drift to dropping the cadence would lose the 'low-frequency, material-only' subscriber-expectation)", () => {
    expect(body).toMatch(/Want changelog entries delivered\?/);
    expect(body).toMatch(/mailto:hello@driftstack\.dev\?subject=Changelog%20subscribe/);
    expect(body).toMatch(
      /Roughly one email\s*\n?\s*every 2-4 weeks; only material changes \(no internal-noise\s*\n?\s*spam\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
