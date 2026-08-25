// W516.C — drift guard for apps/marketing-site/src/pages/docs/profiles.astro.
// V-691 profiles developer docs + W216.A accuracy pass. Drift here either
// changes the snapshot URL routing (would create marketing↔V-312-route
// divergence) or shifts the PROFILES_PER_TIER table (would create
// marketing↔common.ts-tier-cap divergence).
//
//   • V-691 doc-comment framing + W216.A 3-source-of-truth pinning
//     (publicProfile + ProfileSchema + PROFILES_PER_TIER).
//   • SAMPLE_PROFILE 7-field shape with archetype = iphone16pro_ios18_7_safari26_4.
//   • prof_-prefix + flat-no-envelope.
//   • 3-when-to-use ladder: authenticated-scraping + A/B-tested-rendering
//     + archetype-pinning.
//   • POST /v1/profiles 3-field body (name + archetype + description) + 201.
//   • GET /v1/profiles cursor-paginated + default 50 + max 100.
//   • PATCH name/description/folder/tags-are-patchable (folder null-clears,
//     tags exact-set-replace) + clone-to-change-archetype.
//   • DELETE 204 + in-flight sessions keep running + idempotent.
//   • Snapshots V-312: psnap_-prefix + /v1/profile-snapshots/:id/restore
//     (NOT under /v1/profiles/<parent>/snapshots) + immutable.
//   • PROFILES_PER_TIER 8-tier table: Free 1 / Personal 10 /
//     Team 50 / Agency 200 / API Starter 25 / API Builder 100 /
//     API Scale 500 / Enterprise custom.
//   • Privacy: encrypted-at-rest cookies + storage + deleted on account
//     deletion.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/profiles.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W516.C apps/marketing-site/src/pages/docs/profiles.astro content parity', () => {
  const body = read(LIB);

  it("V-691 + W216.A 3-source-file accuracy-pass framing pinned: 'profiles developer docs. Companion to /docs/sessions; covers the saved-profile lifecycle for customers running repeatable, identity-bound automations.' + W216.A accuracy pass pinned against publicProfile in routes/profiles.ts + ProfileSchema + CreateProfileRequestSchema + UpdateProfileRequestSchema in api-types/profiles.ts + PROFILES_PER_TIER in api-types/common.ts — pinned so the V-691 anchor + W216.A 3-source-of-truth commitment survives. Re-enabled by slice 184 after verifying both comments exist at profiles.astro:4-13", () => {
    expect(body).toMatch(
      /\/\/ V-691 — profiles developer docs\. Companion to \/docs\/sessions;\s*\/\/ covers the saved-profile lifecycle for customers running\s*\/\/ repeatable, identity-bound automations\./,
    );
    expect(body).toMatch(
      /\/\/ W216\.A — accuracy pass: pinned against publicProfile in\s*\/\/ apps\/server\/src\/routes\/profiles\.ts, ProfileSchema \+\s*\/\/ CreateProfileRequestSchema \+ UpdateProfileRequestSchema in\s*\/\/ packages\/api-types\/src\/profiles\.ts, and PROFILES_PER_TIER in\s*\/\/ packages\/api-types\/src\/common\.ts\./,
    );
  });

  it('SAMPLE_PROFILE 7-field shape pinned: id (prof_) + name us-east-sales-bot + archetype iphone17_ios18_7_safari26_4 + description Sales-team account for east-coast scraping + last_used_at + created_at + updated_at — pinned so the 7-field publicProfile shape + canonical-archetype-slug + sales-team-example commitments survive (drift to a different field set would create marketing↔ProfileSchema divergence)', () => {
    expect(body).toMatch(/"id": "prof_…"/);
    expect(body).toMatch(/"name": "us-east-sales-bot"/);
    expect(body).toMatch(/"archetype": "iphone17_ios18_7_safari26_4"/);
    expect(body).toMatch(/"description": "Sales-team account for east-coast scraping\."/);
    expect(body).toMatch(/"last_used_at": "2026-05-11T12:00:00\.000Z"/);
    expect(body).toMatch(/"created_at": "2026-05-01T00:00:00\.000Z"/);
    expect(body).toMatch(/"updated_at": "2026-05-11T12:00:00\.000Z"/);
  });

  it("3-when-to-use framing pinned: 'Authenticated scraping.' (login carries over cookies + storage) + 'A/B-tested rendering.' (same variant per run) + 'Archetype pinning.' (lock UA/viewport/timezone/locale) + 'If your automation doesn't care about identity continuity, skip profiles and let sessions run with the account's default archetype.' — pinned so the 3-use-case + skip-profiles-if-stateless commitment survives", () => {
    expect(body).toMatch(
      /<strong>Authenticated scraping\.<\/strong> The site requires\s*login; you want each session to carry over cookies \+ storage\s*without re-authenticating\./,
    );
    expect(body).toMatch(
      /<strong>A\/B-tested rendering\.<\/strong> The site personalises\s*based on cookies; you want each run to see the same variant\./,
    );
    expect(body).toMatch(
      /<strong>Archetype pinning\.<\/strong> You want to lock the\s*browser fingerprint \(UA \/ viewport \/ timezone \/ locale\) to a\s*specific Driftstack-managed archetype slug across runs\./,
    );
    expect(body).toMatch(
      /If your automation doesn't care about identity continuity, skip\s*profiles and let sessions run with the account's default\s*archetype\./,
    );
  });

  it("POST /v1/profiles 3-field body + 201 framing pinned: name + archetype (optional, defaults server-side) + description + 'The response is a flat profile object — no envelope. Profile ids are prefixed prof_.' + 'The archetype field is a lowercase slug (1–120 chars) identifying a Driftstack-managed device profile' + 'Browser state (cookies, localStorage, etc.) is created on first use and is not part of the create request.' — pinned so the 3-field-body + flat-no-envelope + prof_-prefix + 1-120-char-archetype + browser-state-lazy-not-on-create commitments survive (drift to a different archetype slug length bound would create marketing↔CreateProfileRequestSchema divergence)", () => {
    expect(body).toMatch(/"name": "us-east-sales-bot"/);
    expect(body).toMatch(
      /"archetype": "iphone17_ios18_7_safari26_4",\s+← optional, defaults server-side/,
    );
    expect(body).toMatch(/"description": "Sales-team account for east-coast scraping\."/);
    expect(body).toMatch(
      /The response is a flat profile object — no envelope\. Profile\s*ids are prefixed <code>prof_<\/code>\./,
    );
    expect(body).toMatch(
      /The <code>archetype<\/code>\s*field is a lowercase slug \(1–120 chars\) identifying a\s*Driftstack-managed device profile;/,
    );
    expect(body).toMatch(
      /Browser state\s*\(cookies, localStorage, etc\.\) is created on first use and is\s*not part of the create request\./,
    );
  });

  it("GET /v1/profiles cursor-paginated + default 50 / max 100 framing pinned + PATCH name/description/folder/tags-patchable (folder null-clears, tags exact-set-replace) + clone-to-change-archetype 'POST /v1/profiles/:id/clone' + 'the archetype is set at create time and pins the device identity for the life of the profile' — pinned so the cursor-pagination + 50-default + 100-max + 4-PATCH-fields + clone-not-PATCH-for-archetype commitments survive", () => {
    // V-1117 — anchored; `limit=250` matched this before, and 250 exceeds the
    // 100 the pagination schema enforces, so the example would have 400d.
    expect(body).toMatch(/GET \/v1\/profiles\?limit=25\b/);
    expect(body).toMatch(
      /Cursor pagination\. Default page size <strong>50<\/strong>; max\s*<strong>100<\/strong>\./,
    );
    expect(body).toMatch(
      /<code>name<\/code>, <code>description<\/code>, <code>folder<\/code>\s*and <code>tags<\/code> are patchable/,
    );
    expect(body).toMatch(/<code>folder: null<\/code>\s*files the profile back under no folder/);
    expect(body).toMatch(/an exact-set replace \(<code>\[\]<\/code> clears them\)/);
    expect(body).toMatch(
      /To change the\s*archetype, clone the profile via\s*<code>POST \/v1\/profiles\/:id\/clone<\/code> and discard the old\s*one \(the archetype is set at create time and pins the device\s*identity for the life of the profile\)\./,
    );
  });

  it("DELETE /v1/profiles/:id 204 + in-flight-sessions keep running + idempotent framing pinned: 'The profile + its persisted browser state are removed. In-flight sessions that started with this profile keep running but can't be pinned to it again. Idempotent: a second DELETE on the same id returns 204.' — pinned so the 204 + state-removed + in-flight-survives-but-can't-repin + idempotent commitment survives", () => {
    expect(body).toMatch(/→ 204 No Content/);
    expect(body).toMatch(
      /The profile \+ its persisted browser state are removed\.\s*In-flight sessions that started with this profile keep running\s*but can't be pinned to it again\. Idempotent: a second DELETE\s*on the same id returns 204\./,
    );
  });

  it('Snapshots contract framing pinned with a customer-facing heading', () => {
    expect(body).toMatch(/<h2>Snapshots<\/h2>/);
    expect(body).toMatch(/POST \/v1\/profiles\/prof_…\/snapshots/);
    expect(body).toMatch(/"id": "psnap_…"/);
    expect(body).toMatch(/"parent_profile_id": "prof_…"/);
    expect(body).toMatch(/"parent_archetype": "iphone17_ios18_7_safari26_4"/);
    expect(body).toMatch(/"parent_name": "us-east-sales-bot"/);
    expect(body).toMatch(/"captured_at": "2026-05-12T12:00:00\.000Z"/);
    expect(body).toMatch(/POST \/v1\/profile-snapshots\/psnap_…\/restore/);
    expect(body).toMatch(
      /Snapshot ids are prefixed <code>psnap_<\/code>\. The\s*restore endpoint lives under <code>\/v1\/profile-snapshots<\/code>,\s*not under <code>\/v1\/profiles\/&lt;parent&gt;\/snapshots<\/code>\.\s*Each restore creates a fresh profile; the snapshot itself is\s*immutable\./,
    );
  });

  it("Privacy 3-bullet framing pinned: 'Cookies + storage state are stored in encrypted form at rest in the driver layer.' + 'Profile metadata + snapshot rows are deleted on account deletion + per the documented retention policy.' + 'No identifying customer data is embedded in the profile record — the only customer-supplied fields are name and description.' — pinned so the 3-privacy-bullet + encrypted-at-rest + no-PII-in-profile-record commitment survives", () => {
    expect(body).toMatch(
      /<li>Cookies \+ storage state are stored in encrypted form at\s*rest in the driver layer\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Profile metadata \+ snapshot rows are deleted on account\s*deletion \+ per the documented retention policy\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>No identifying customer data is embedded in the profile\s*record — the only customer-supplied fields are\s*<code>name<\/code> and <code>description<\/code>\.<\/li>/,
    );
  });

  it('PROFILES_PER_TIER 8-tier table pinned: Free 1 / Personal 10 / Team 50 / Agency 200 / API Starter 25 / API Builder 100 / API Scale 500 / Enterprise custom — pinned so the 8-tier-cap table stays consistent with PROFILES_PER_TIER in common.ts (drift to a different cap on any tier would create marketing↔server divergence)', () => {
    expect(body).toMatch(/<tr><td>Free<\/td><td>1<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>Personal<\/td><td>10<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>Team<\/td><td>50<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>Agency<\/td><td>200<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>API Starter<\/td><td>25<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>API Builder<\/td><td>100<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>API Scale<\/td><td>500<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>Enterprise<\/td><td>custom<\/td><\/tr>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
