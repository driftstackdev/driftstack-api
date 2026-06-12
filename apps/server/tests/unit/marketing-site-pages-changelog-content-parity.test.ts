// W499.A — drift guard for apps/marketing-site/src/pages/changelog.astro.
// Public changelog landing page. Drift here either drops the
// 6-category enum (would render category badges with no styling) or
// re-introduces engineering-internal V-NNN tags (which rotate fast
// and confuse customers).
//
//   • Hand-authored placeholder framing + Build-time generator
//     followup.
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
//   • 2026-05-03 pricing: 2-ladder + crypto deferred.
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

  it("Build-time generator follow-on doc-comment framing pinned: 'Placeholder entries. Once the verification log + tagged GitHub releases stabilize, this file becomes a build-time generator that reads from a manually-maintained markdown source under apps/marketing-site/src/data/changelog.md and renders entries here. Until then, the entries below are hand-authored highlights of customer-facing changes.' — pinned so the 'this is currently hand-authored' rationale + the planned changelog.md path stay documented (drift to dropping would let a future maintainer assume the generator already exists)", () => {
    expect(body).toMatch(
      /\/\/ Placeholder entries\. Once the verification log \+ tagged GitHub\s*\n?\s*\/\/ releases stabilize, this file becomes a build-time generator that\s*\n?\s*\/\/ reads from a manually-maintained markdown source under\s*\n?\s*\/\/ `apps\/marketing-site\/src\/data\/changelog\.md`/,
    );
  });

  it("ChangelogEntry 6-category enum: launch / sdk / docs / security / pricing / self-hosted — pinned so the category taxonomy stays 6-state (drift to dropping any would render an entry with TypeScript's never type; drift to adding new would create an entry the CATEGORY_COLOR map doesn't cover, rendering with no styling)", () => {
    expect(body).toMatch(
      /category: 'launch' \| 'sdk' \| 'docs' \| 'security' \| 'pricing' \| 'self-hosted';/,
    );
  });

  it("CATEGORY_COLOR 6-entry styling map: launch oxblood / sdk slate-900 / docs slate-200 / security red / pricing amber / self-hosted emerald — pinned so each category has a visually-distinct badge color (drift to dropping any would render that category's badge with no styling; drift to duplicating would lose the 'launch is the loud one, security is alarm-red' visual hierarchy)", () => {
    expect(body).toMatch(
      /const CATEGORY_COLOR: Record<ChangelogEntry\['category'\], string> = \{\s*\n?\s*launch: 'bg-tk-accent text-white',\s*\n?\s*sdk: 'bg-tk-bg text-white',\s*\n?\s*docs: 'bg-tk-raised text-tk-ink',\s*\n?\s*security: 'bg-red-100 text-red-900',\s*\n?\s*pricing: 'bg-amber-100 text-tk-accent-soft',\s*\n?\s*'self-hosted': 'bg-emerald-100 text-emerald-200',\s*\n?\s*\};/,
    );
  });

  it("Hero framing: 'What changed.' heading + 'Customer-facing changes, in reverse-chronological order. SDK releases, pricing changes, security posture updates, self-hosted-tier adjustments. Engineering-internal changes (refactors, test fixtures, observability work) live in the verification log inside the repo, not here.' — pinned so the customer-facing-only scope + the engineering-internal exclusion both survive (drift to including engineering-internal would clutter the changelog with noise customers don't care about)", () => {
    expect(body).toMatch(/What changed\./);
    expect(body).toMatch(
      /Customer-facing changes, in reverse-chronological order\. SDK\s*\n?\s*releases, pricing changes, security posture updates,\s*\n?\s*self-hosted-tier adjustments\. Engineering-internal changes\s*\n?\s*\(refactors, test fixtures, observability work\) live in the\s*\n?\s*verification log inside the repo, not here\./,
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

  it("2026-05-03 'Crypto payment rail deferred to post-launch' security entry: 'Coinbase Commerce closed for non-US/Singapore merchants 2026-03-31. Stripe is sole launch payment rail (fiat-only). Crypto re-evaluates against actual transaction volume.' — pinned so the why-no-crypto-at-launch rationale + the Stripe-only + the post-launch re-evaluation framing all survive (drift to dropping would orphan customers asking 'why no crypto?')", () => {
    expect(body).toMatch(/Crypto payment rail deferred to post-launch/);
    expect(body).toMatch(
      /Coinbase Commerce closed for non-US\/Singapore merchants 2026-03-31\. Stripe is sole launch payment rail \(fiat-only\)\. Crypto re-evaluates against actual transaction volume\./,
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
