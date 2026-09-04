// W774 — apps/docs api/profile-snapshots.md content parity. One-
// hundredth in the cross-SDK drift-guard series. Closes the
// apps/docs/api/ subtree sweep (15/15 covered).
//
// /api/profile-snapshots is the canonical programmatic reference for
// V-312 snapshot capture/list/restore/delete. Drift to the immutable
// framing or the tier-cap-on-restore-not-capture contract would
// mismatch W756 dashboard /snapshots + V-312 server enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profile-snapshots.md');

describe('W774 docs /api/profile-snapshots content parity', () => {
  it('api/profile-snapshots.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads capture+list+restore + immutable-point-in-time framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Profile snapshots\n/,
    );
    // S36 2026-07-07 (fable-truth-audit): "copies" → "metadata records" —
    // v1 snapshots are metadata-only (services/profile-snapshots.ts header:
    // captures land stateBlob {}; no browser state is stored or restored).
    expect(p).toMatch(
      /description: Capture, list, and restore immutable point-in-time metadata records of saved profiles\. Frozen snapshots survive while the source profile keeps evolving\./,
    );
  });

  it("CRITICAL profiles-evolve-vs-snapshots-are-frozen 2-bullet model pinned. The 'Profiles evolve: every session you run against a profile may mutate cookies, localStorage, IndexedDB, etc.' + 'Snapshots are frozen: capture an evolving profile into a named snapshot, and the snapshot\\'s contents remain unchanged even as the source profile keeps changing.' wording matches W756 + W763 immutable framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Profiles\*\* evolve: every session you run against a profile/);
    expect(p).toMatch(/may mutate cookies, `localStorage`, IndexedDB, etc\./);
    // S36 2026-07-07 (fable-truth-audit): "frozen" → "frozen metadata" —
    // what's frozen is archetype/name/description, never browser state.
    expect(p).toMatch(/\*\*Snapshots\*\* are frozen metadata: capture an evolving profile into a/);
    // The metadata-only truth banner must stay present.
    expect(p).toMatch(/\*\*What a snapshot does NOT capture at v1: browser state\.\*\*/);
    expect(p).toMatch(
      /Cookies, `localStorage`, IndexedDB, and logins are not copied into\s*\n?the snapshot, and restoring one does not bring them back\./,
    );
  });

  it("CRITICAL restore creates-NEW-profile-row framing pinned. S36 2026-07-07 (fable-truth-audit): the old 'populated from the snapshot's frozen state' framing was FALSE — restore() creates a fresh profile carrying only the snapshot's parent archetype + description (services/profile-snapshots.ts restore(); capture() writes stateBlob: {}), so the doc now says frozen archetype + description and fresh empty browser state.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Restoring a snapshot creates a \*\*new profile row\*\* carrying the\s*\n?snapshot's frozen archetype \+ description — the source profile is\s*\n?untouched, and the new profile starts with fresh \(empty\) browser\s*\n?state\./,
    );
    // Negative pin — the retired frozen-STATE fiction must not come back.
    expect(p).not.toMatch(/populated from\s*\n?the snapshot's frozen state/);
  });

  it('CRITICAL snapshots-surface cross-reference pinned: captured/restored in the Driftstack desktop app (2026-07-02 account-portal IA — the web /snapshots dashboard page was retired; drift back to an app.driftstack.io/snapshots link would resurrect a 404).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Snapshots are captured and restored in the Driftstack desktop app/);
    expect(p).not.toMatch(/app\.driftstack\.io\/snapshots/);
  });

  it('CRITICAL psnap_ id prefix pinned. Matches W756 dashboard /snapshots + W763 /api/profiles snapshots reference + V-312 server-side prefix.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"id": "psnap_<uuid>"/);
  });

  it('CRITICAL capture POST /v1/profiles/:id/snapshots body shape — { label, description? }. The response is the publicSnapshot shape: id/parent_profile_id/label/description/parent_archetype/parent_name/captured_at (matches apps/server/src/routes/profile-snapshots.ts + all 3 SDKs; NOT the stale profile_id/name/size_bytes shape).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/profiles\/:id\/snapshots`/);
    expect(p).toMatch(/"label": "post-login-known-good"/);
    expect(p).toMatch(/"parent_profile_id": "prof_<uuid>"/);
    expect(p).toMatch(/"parent_archetype":/);
    expect(p).toMatch(/"parent_name":/);
    expect(p).toMatch(/"captured_at":/);
    // Guard against regressing to the stale shape.
    expect(p).not.toMatch(/"size_bytes":/);
  });

  it('CRITICAL capture error roster pinned: 404 = not-yours profile id. The capture service (services/profile-snapshots.ts:120-137) only throws NotFoundError; there is NO 409-on-duplicate-label (labels are not unique), so the doc must NOT claim one.', () => {
    const p = read(PAGE);

    // V-1103 — every handler in routes/profile-snapshots.ts resolves an
    // effective account, and this page stated the calling-account rule at four
    // separate errors. This pin froze one of them.
    expect(p).toMatch(/`404 not-found` — the profile id doesn't belong to the effective/);
    expect(p, 'the calling-account 404 wording must not return anywhere on this page').not.toMatch(
      /belong to the calling\s*account/,
    );
    // Guard against a 409-on-duplicate-label reappearing in the Capture
    // errors block — capture() does not enforce label uniqueness.
    const captureSection = p.slice(
      p.indexOf('## Capture a snapshot of a profile'),
      p.indexOf('## List snapshots of a profile'),
    );
    expect(captureSection).not.toMatch(/`409 conflict` — a snapshot with this `label`/);
  });

  it('CRITICAL per-profile vs cross-account list endpoints pinned. The 2-endpoint split (/v1/profiles/:id/snapshots per-profile + /v1/profile-snapshots cross-account with profile_name field) matches W763 + W756.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/profiles\/:id\/snapshots`/);
    expect(p).toMatch(/Returns all snapshots of profile `:id`, newest first\./);
    expect(p).toMatch(/`GET \/v1\/profile-snapshots`/);
    // V-1103 — the scope is the EFFECTIVE account. The handler resolves
    // `eff.kind === 'team' ? eff.accountId : ctx.account.id`, so a team admin
    // acting as an owner lists the OWNER's snapshots, not their own. The page
    // said "the calling account", which is the answer only when no header is
    // sent, and this pin froze it.
    expect(p).toMatch(/Returns every snapshot the effective account owns, across all profiles —/);
    expect(p, 'the calling-account claim must not return').not.toMatch(
      /every snapshot the calling account owns/,
    );
    // Scoped to the cross-account LIST registration, not the file. Three
    // handlers resolve the same way, so a file-wide match survives deleting
    // one — measured: removing it from this handler left the arm green, which
    // is the population-detection failure this suite keeps finding in others.
    const routeSrc = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'),
      'utf8',
    );
    const listAt = routeSrc.indexOf("'/v1/profile-snapshots',");
    expect(listAt, 'the cross-account list registration moved').toBeGreaterThan(0);
    expect(
      routeSrc.slice(listAt, routeSrc.indexOf("'/v1/profile-snapshots/:id'", listAt)),
      'the cross-account list handler no longer resolves an effective account, so the page wording ' +
        'should follow it back to the calling account',
    ).toMatch(/const accountId = eff\.kind === 'team' \? eff\.accountId : ctx\.account\.id;/);
  });

  it("CRITICAL cross-account list per-row parent_name framing pinned. The 'Each row carries parent_name … handy when listing across profiles so you don\\'t have to issue a second fetch per row' wording is the load-bearing N+1-avoidance comm (field is parent_name, matching publicSnapshot — NOT the stale profile_name).", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Each row carries `parent_name`/);
    expect(p).toMatch(/handy when listing across profiles/);
    expect(p).not.toMatch(/`profile_name`/);
  });

  it('CRITICAL restore POST /v1/profile-snapshots/:id/restore creates new profile pinned. Response shape includes the new prof_ id + archetype + last_used_at:null. Drift to dropping the new-profile-shape would let SDK consumers crash on the response.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/profile-snapshots\/:id\/restore`/);
    // S36 2026-07-07 (fable-truth-audit): metadata-only restore truth.
    expect(p).toMatch(
      /Creates a new profile carrying the snapshot's frozen metadata —\s*\n?archetype and description — under the name you supply\./,
    );
    expect(p).toMatch(
      /The new profile starts with fresh \(empty\)\s*\n?browser state: restore does not bring back cookies or logins\./,
    );
    expect(p).toMatch(/"id": "prof_<uuid>"/);
    expect(p).toMatch(/"archetype": "iphone17_ios18_7_safari26_4"/);
    expect(p).toMatch(/"last_used_at": null/);
  });

  it("CRITICAL restore 3-error-code set pinned — 404 (not yours) / 409 (name taken) / 429 (tier-limit). The 'Snapshot restore counts against the same cap as profile-create' wording matches W756 dashboard /snapshots restore-form 'counts against your profile tier cap' framing.", () => {
    const p = read(PAGE);

    // V-1103 — effective account, not calling. The restore handler resolves
    // `effectiveAccountIdForWrite`, so a team admin restores from the OWNER's
    // snapshots. This is the second pin on this page that froze the old rule.
    expect(p).toMatch(/`404 not-found` — the snapshot id doesn't belong to the effective/);
    expect(p).toMatch(
      /`409 conflict` — a profile with the requested `name` already\s*\n?\s+exists\./,
    );
    expect(p).toMatch(
      /`429 tier-limit` — the new profile would push the account over\s*\n?\s+its `PROFILES_PER_TIER` cap\. Snapshot restore counts against\s*\n?\s+the same cap as profile-create\./,
    );
  });

  it("CRITICAL DELETE /v1/profile-snapshots/:id returns 204 + source-profile-untouched framing pinned. The 'Permanently deletes the snapshot. The source profile is not affected. Returns 204 on success' wording is the load-bearing destroy contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`DELETE \/v1\/profile-snapshots\/:id`/);
    expect(p).toMatch(
      /Permanently deletes the snapshot\. The source profile is not\s*\n?affected\. Returns 204 on success\./,
    );
  });

  it('CRITICAL restore audit event pinned — restore emits `profile.created` (creating the new profile); capture + delete emit NO audit entry. The fabricated profile_snapshot.captured/.restored/.deleted actions do not exist in the snapshot service (profile-snapshots.ts emits profile.created on restore only); a consumer subscribing to those would never match. Drift sentinel against the bad action names.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`profile\.created` — fires on restore \(creating the new profile\)\./);
    expect(p).toMatch(/restored_from_snapshot/);
    expect(p).toMatch(/Capture and delete do not emit an audit entry today\./);
    // Drift sentinel — the fabricated action names MUST NOT come back.
    expect(p).not.toMatch(/profile_snapshot\.captured/);
    expect(p).not.toMatch(/profile_snapshot\.restored/);
    expect(p).not.toMatch(/profile_snapshot\.deleted/);
  });

  it("CRITICAL snapshots-NOT-counted-against-tier framing pinned. The 'Snapshots themselves are NOT counted against PROFILES_PER_TIER. You can hold many snapshots per profile, and many snapshots per account, without affecting your profile-cap budget' wording is the load-bearing customer-comms.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Snapshots themselves are NOT counted against `PROFILES_PER_TIER`\./);
    expect(p).toMatch(
      /You can hold many snapshots per profile, and many snapshots per\s*\n?account, without affecting your profile-cap budget\./,
    );
  });

  it("CRITICAL restore-DOES-count-against-tier framing pinned. The 'Restoring a snapshot DOES count: the new profile created from the restore is subject to the same PROFILES_PER_TIER cap as a manually-created profile' wording explains the asymmetric cap behavior.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Restoring a snapshot DOES count: the new profile created from the\s*\n?restore is subject to the same `PROFILES_PER_TIER` cap as a\s*\n?manually-created profile\./,
    );
  });

  it("CRITICAL at-cap recovery instructions pinned. The 'If your tier is at-cap, the restore returns 429 tier-limit and the customer must either delete a profile first or upgrade tier' wording is the canonical customer-action framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /If your tier is at-cap, the restore\s*\n?returns `429 tier-limit` and the customer must either delete a\s*\n?profile first or upgrade tier\./,
    );
  });

  it("CRITICAL no-per-account-snapshot-quota framing pinned. The 'There is no per-account snapshot quota at v1' wording explains the unbounded-snapshot model.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/There is no per-account snapshot quota at v1\./);
  });

  it("CRITICAL storage-characteristics framing pinned: plain metadata rows + no browser-state payload stored at v1 + frozen parent_archetype/parent_name + no per-account quota. S36 2026-07-07 (fable-truth-audit): the old 'stored in the underlying driver-managed storage layer' claim was FALSE — snapshots are DB rows with an always-empty stateBlob jsonb column (db/schema.ts state_blob; services/profile-snapshots.ts capture() writes {}); nothing lives in a driver-managed layer. (Also keeps the earlier stale-size_bytes guard.)", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Snapshots are plain metadata rows stored separately from live profiles —\s*\n?at v1 no browser-state payload is stored anywhere/,
    );
    expect(p).toMatch(/freezes the\s*\n?source profile's archetype \+ name/);
    expect(p).toMatch(/There is no per-account snapshot quota at v1\./);
    // Guards against the stale claims returning.
    expect(p).not.toMatch(/`size_bytes`/);
    expect(p).not.toMatch(/driver-managed storage layer/);
  });

  it('CRITICAL scope set — read|read:profiles + write|write:profiles framing pinned. The 2-shape (broad + granular) matches W750 dashboard /api-keys V-481 granular-scope picker.', () => {
    const p = read(PAGE);

    const readScopeMatches = (p.match(/Required scope: `read` or `read:profiles`\./g) ?? []).length;
    expect(readScopeMatches).toBeGreaterThanOrEqual(3);
    const writeScopeMatches = (p.match(/Required scope: `write` or `write:profiles`\./g) ?? [])
      .length;
    expect(writeScopeMatches).toBeGreaterThanOrEqual(3);
  });

  // V-1143 — the third pointer named a file that does not exist. `api-types` has no
  // snapshot module at all; the ProfileSnapshot schemas are declared in `profiles.ts`.
  // This pin froze the wrong path, so the page could not be corrected without a red —
  // the shape where a guard holds a false claim in place rather than catching one.
  it('CRITICAL Source-of-truth pointers pinned — the two server modules plus the api-types module that actually declares the ProfileSnapshot schemas. A pointer a reader cannot open is worse than no pointer: it reads as precision.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Routes: `apps\/server\/src\/routes\/profile-snapshots\.ts`\./);
    expect(p).toMatch(/`apps\/server\/src\/services\/profile-/);
    expect(p).toMatch(/snapshots\.ts`/);
    expect(p).toMatch(/`packages\/api-types\/src\/profiles\.ts`/);

    // V-1143 negative — the module named here until now never existed. Quoted so the
    // dead path cannot come back; the retraction above paraphrases it.
    expect(p, 'the non-existent api-types snapshot module is cited again').not.toMatch(
      /api-types\/src\/profile-snapshots\.ts/,
    );
  });

  it('CRITICAL 5-endpoint canonical action set — POST capture + GET per-profile list + GET cross-account list + GET single + POST restore + DELETE.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/profiles\/:id\/snapshots`/);
    expect(p).toMatch(/`GET \/v1\/profiles\/:id\/snapshots`/);
    expect(p).toMatch(/`GET \/v1\/profile-snapshots`$|`GET \/v1\/profile-snapshots`\s/m);
    expect(p).toMatch(/`GET \/v1\/profile-snapshots\/:id`/);
    expect(p).toMatch(/`POST \/v1\/profile-snapshots\/:id\/restore`/);
    expect(p).toMatch(/`DELETE \/v1\/profile-snapshots\/:id`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-api-profile-snapshots-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
