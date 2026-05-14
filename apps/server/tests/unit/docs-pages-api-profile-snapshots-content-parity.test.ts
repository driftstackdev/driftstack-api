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
    expect(p).toMatch(
      /description: Capture, list, and restore immutable point-in-time copies of saved profiles\. Frozen snapshots survive while the source profile keeps evolving\./,
    );
  });

  it("CRITICAL profiles-evolve-vs-snapshots-are-frozen 2-bullet model pinned. The 'Profiles evolve: every session you run against a profile may mutate cookies, localStorage, IndexedDB, etc.' + 'Snapshots are frozen: capture an evolving profile into a named snapshot, and the snapshot\\'s contents remain unchanged even as the source profile keeps changing.' wording matches W756 + W763 immutable framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Profiles\*\* evolve: every session you run against a profile/);
    expect(p).toMatch(/may mutate cookies, `localStorage`, IndexedDB, etc\./);
    expect(p).toMatch(/\*\*Snapshots\*\* are frozen: capture an evolving profile into a/);
  });

  it("CRITICAL restore creates-NEW-profile-row framing pinned. The 'Restoring a snapshot creates a **new profile row** populated from the snapshot\\'s frozen state — the source profile is untouched and the new profile starts evolving from there' wording matches W756 dashboard /snapshots restore-form contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Restoring a snapshot creates a \*\*new profile row\*\* populated from\s*\n?the snapshot's frozen state — the source profile is untouched and\s*\n?the new profile starts evolving from there\./,
    );
  });

  it('CRITICAL /snapshots dashboard-surface cross-reference pinned. Drift would lose the canonical W756 dashboard link.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\[\/snapshots\]\(https:\/\/app\.driftstack\.dev\/snapshots\)\./);
  });

  it('CRITICAL psnap_ id prefix pinned. Matches W756 dashboard /snapshots + W763 /api/profiles snapshots reference + V-312 server-side prefix.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"id": "psnap_<uuid>"/);
  });

  it('CRITICAL capture POST /v1/profiles/:id/snapshots body shape — { name } only. The response shape includes id/profile_id/name/captured_at/size_bytes — drift to dropping a field would break SDK consumer typings.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/profiles\/:id\/snapshots`/);
    expect(p).toMatch(/"name": "post-login-known-good"/);
    expect(p).toMatch(/"profile_id": "prof_<uuid>"/);
    expect(p).toMatch(/"captured_at":/);
    expect(p).toMatch(/"size_bytes":/);
  });

  it('CRITICAL capture 404+409 error pair pinned. 404 = not-yours profile id; 409 = duplicate snapshot name for this profile. Drift would let SDK consumers misclassify failures.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`404 not-found` — the profile id doesn't belong to the calling/);
    expect(p).toMatch(/account\./);
    expect(p).toMatch(
      /`409 conflict` — a snapshot with this `name` already exists for\s*\n?\s+this profile\./,
    );
  });

  it('CRITICAL per-profile vs cross-account list endpoints pinned. The 2-endpoint split (/v1/profiles/:id/snapshots per-profile + /v1/profile-snapshots cross-account with profile_name field) matches W763 + W756.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/profiles\/:id\/snapshots`/);
    expect(p).toMatch(/Returns all snapshots of profile `:id`, newest first\./);
    expect(p).toMatch(/`GET \/v1\/profile-snapshots`/);
    expect(p).toMatch(
      /Returns every snapshot the calling account owns, across all\s*\n?profiles\./,
    );
  });

  it("CRITICAL cross-account list includes profile_name framing pinned. The 'Note the additional profile_name field — handy when listing across profiles so you don\\'t have to issue a second fetch per row' wording is the load-bearing N+1-avoidance comm.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Note the additional `profile_name` field — handy when listing\s*\n?across profiles so you don't have to issue a second fetch per\s*\n?row\./,
    );
  });

  it('CRITICAL restore POST /v1/profile-snapshots/:id/restore creates new profile pinned. Response shape includes the new prof_ id + archetype + last_used_at:null. Drift to dropping the new-profile-shape would let SDK consumers crash on the response.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/profile-snapshots\/:id\/restore`/);
    expect(p).toMatch(/Creates a new profile populated from the snapshot's frozen state\./);
    expect(p).toMatch(/"id": "prof_<uuid>"/);
    expect(p).toMatch(/"archetype": "iphone16pro_ios18_7_safari26_4"/);
    expect(p).toMatch(/"last_used_at": null/);
  });

  it("CRITICAL restore 3-error-code set pinned — 404 (not yours) / 409 (name taken) / 429 (tier-limit). The 'Snapshot restore counts against the same cap as profile-create' wording matches W756 dashboard /snapshots restore-form 'counts against your profile tier cap' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`404 not-found` — the snapshot id doesn't belong to the calling/);
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

  it('CRITICAL 3-audit-event lifecycle pinned — profile_snapshot.captured / .restored / .deleted. Drift would let SDK consumers fail to subscribe to audit-trail.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`profile_snapshot\.captured` — fires on snapshot create\./);
    expect(p).toMatch(/`profile_snapshot\.restored` — fires on restore\./);
    expect(p).toMatch(/`profile_snapshot\.deleted` — fires on delete\./);
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

  it("CRITICAL no-per-account-snapshot-quota framing pinned. The 'There is no per-account snapshot quota at v1; very-high-snapshot accounts will see the size figure in audit context' wording explains the unbounded-snapshot model.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /There is no per-account snapshot quota at v1; very-high-snapshot\s*\n?accounts will see the size figure in audit context\./,
    );
  });

  it("CRITICAL size_bytes-on-capture framing pinned. The 'The size_bytes field on every snapshot is the on-disk size at capture time — useful for understanding the ballpark cost of holding many snapshots' wording is the load-bearing customer-comms about storage.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `size_bytes` field\s*\n?on every snapshot is the on-disk size at capture time — useful\s*\n?for understanding the ballpark cost of holding many snapshots\./,
    );
  });

  it('CRITICAL scope set — read|read:profiles + write|write:profiles framing pinned. The 2-shape (broad + granular) matches W750 dashboard /api-keys V-481 granular-scope picker.', () => {
    const p = read(PAGE);

    const readScopeMatches = (p.match(/Required scope: `read` or `read:profiles`\./g) ?? []).length;
    expect(readScopeMatches).toBeGreaterThanOrEqual(3);
    const writeScopeMatches = (p.match(/Required scope: `write` or `write:profiles`\./g) ?? [])
      .length;
    expect(writeScopeMatches).toBeGreaterThanOrEqual(3);
  });

  it('CRITICAL Source-of-truth pointers pinned — routes/profile-snapshots.ts + services/profile-snapshots.ts + packages/api-types/src/profile-snapshots.ts.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Routes: `apps\/server\/src\/routes\/profile-snapshots\.ts`\./);
    expect(p).toMatch(/`apps\/server\/src\/services\/profile-/);
    expect(p).toMatch(/snapshots\.ts`/);
    expect(p).toMatch(/`packages\/api-types\/src\/profile-snapshots\.ts`/);
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
