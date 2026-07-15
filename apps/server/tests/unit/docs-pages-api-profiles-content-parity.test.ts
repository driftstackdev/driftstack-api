// W763 — apps/docs api/profiles.md content parity. Eighty-ninth in
// the cross-SDK drift-guard series.
//
// /api/profiles is the canonical reference for the profile +
// snapshot lifecycle. Drift to the PROFILES_PER_TIER table or the
// "snapshots are immutable" framing would let SDK consumers'
// expectations diverge from server enforcement and the W752 + W756
// dashboard surfaces.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profiles.md');

describe('W763 docs /api/profiles content parity', () => {
  it('api/profiles.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads the 6-action lifecycle (create/list/get/patch/clone/delete) + tier-cap-at-create-and-clone framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Profiles\n/);
    expect(p).toMatch(
      /description: Manage saved browser profiles — create, list, get, patch, clone, delete\. Tier-cap enforced at create \+ clone\./,
    );
  });

  it("CRITICAL persistent-identity framing pinned. The 'A profile is a named, persistent browser identity Driftstack remembers between sessions. Cookies, localStorage, IndexedDB, service workers, and any state the underlying WebKit engine retains are kept under one logical handle' wording matches W752 dashboard profile framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/A \*\*profile\*\* is a named, persistent browser identity Driftstack/);
    expect(p).toMatch(/remembers between sessions\. Cookies, `localStorage`, `IndexedDB`,/);
    expect(p).toMatch(/service workers, and any state the underlying WebKit engine/);
  });

  it('CRITICAL PROFILES_PER_TIER table pinned with all 8 tiers + caps. Matches W752 dashboard /profiles tier-display constant + V-136 server-side enforcement.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Values\s*\n?mirror `PROFILES_PER_TIER` in `@driftstack\/api-types`:/);

    const tierCaps: Array<[string, string]> = [
      ['free', '1'],
      ['solo_manual', '10'],
      ['team_manual', '50'],
      ['agency_manual', '200'],
      ['api_starter', '25'],
      ['api_builder', '100'],
      ['api_scale', '500'],
      ['enterprise', 'custom'],
    ];
    for (const [tier, cap] of tierCaps) {
      expect(p, `${tier} → ${cap}`).toMatch(new RegExp(`\\| \`${tier}\`\\s+\\|\\s+${cap} \\|`));
    }
  });

  it("CRITICAL enterprise profile_cap returns null framing pinned. The 'The cap on enterprise tier is negotiated; the API returns profile_cap: null on /v1/account/me for enterprise customers' wording matches W752 dashboard atLimit 'custom'-sentinel handling.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The cap on enterprise tier is negotiated; the API returns\s*\n?`profile_cap: null` on `\/v1\/account\/me` for enterprise customers\./,
    );
  });

  it('CRITICAL 429 Tier limit error response body extension pinned — {limit, current, resource: "profile", tier}. Drift would let SDK consumers fail to surface the 4-field framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`429 TierLimit` — account at the profile cap\. Body extension:\s*\n?\s+`\{limit, current, resource: "profile", tier\}`\./,
    );
  });

  it('CRITICAL name shape constraints pinned — unique-within-account + lowercase + hyphen recommended + max 120 chars + start/end alphanumeric + allowed inner chars (letters/digits/space/underscore/hyphen/dot). Matches ProfileNameSchema; drift would mis-state the constraint and make SDK consumers avoid valid names or send rejected ones.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`name` — unique within the account\. Lowercase \+ hyphen recommended;/);
    expect(p).toMatch(/max 120 chars\. Must start and end with an alphanumeric character;/);
    expect(p).toMatch(/allowed inner characters are letters, digits, spaces, underscore,/);
    expect(p).toMatch(/hyphen, and dot\. Leading\/trailing whitespace is trimmed\./);
  });

  it("CRITICAL archetype-is-sticky-for-lifetime framing pinned. The 'Once set, the archetype is sticky for that profile\\'s lifetime' wording + the 'repin via POST /v1/profiles/:id/clone with a new archetype' fallback explains the no-archetype-edit contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Once set,\s*\n?\s+the archetype is sticky for that profile's lifetime\./);
    expect(p).toMatch(
      /The\s*\n?archetype is intentionally not editable — repin via\s*\n?`POST \/v1\/profiles\/:id\/clone` with a new archetype, then delete the\s*\n?old profile after migration\./,
    );
  });

  it('new create/import archetypes come from the live catalog while stored legacy profile operations remain available', () => {
    const p = read(PAGE);

    expect(p).toContain('[`GET /v1/archetypes`](/api/archetypes/)');
    expect(p).toMatch(
      /A well-formed unknown, reference-only, or planned id is rejected before\s*\n?the profile repository is read or written\./,
    );
    expect(p).toMatch(
      /Import is a new-profile write, so `envelope\.profile\.archetype` must be present\s*\n?in the current selectable catalog\./,
    );
    expect(p).toMatch(
      /Existing profiles preserve their stored archetype even after it leaves\s*\n?the selectable catalog\. They remain listable, readable, clonable, transferable,\s*\n?snapshot-restorable, and launchable/,
    );
  });

  it('CRITICAL description max 2048 chars + nullable framing pinned. Drift to a different bound would let SDK validation diverge from server enforcement.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`description` — free-form, max 2048 chars; nullable\./);
    expect(p).toMatch(/field, `description` over 2048 chars,/);
  });

  it("CRITICAL create returns 200 (not 201) framing pinned. The 'the API surface uses 200 for both idempotent and one-shot resource creation' clause is the load-bearing API-versioning convention.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Returns the created\s*\n?profile \(200, not 201 — the API surface uses 200 for both\s*\n?idempotent and one-shot resource creation\)\./,
    );
  });

  it('CRITICAL clone auto-name-derivation caps at 99 framing pinned. The "(caps at 99 to avoid runaway loops; rejects with 409 if it gets there)" matches W752 dashboard /profiles clone-confirm framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /naming \(caps at 99 to avoid runaway loops; rejects with 409 if it\s*\n?gets there\)\./,
    );
  });

  it("CRITICAL clone-fresh-state framing pinned. The 'Underlying browser state is NOT cloned — the new profile starts with a fresh state slot under the same archetype' wording is the load-bearing customer-expectation framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Underlying\s*\n?browser state is NOT cloned — the new profile starts with a fresh\s*\n?state slot under the same archetype\./,
    );
  });

  it('CRITICAL clone audit-log carries payload.cloned_from framing pinned. Matches W755 /audit-log V-381 clone+snapshot-restore shared filter.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `audit_log`\s*\n?entry for `profile\.created` carries `payload\.cloned_from:\s*\n?profile_<source-id>`/,
    );
  });

  it("CRITICAL snapshots-are-immutable-METADATA framing pinned. S36 2026-07-07 (fable-truth-audit): 'copies' → 'metadata records' — v1 snapshots capture archetype/name/description only, never browser state (services/profile-snapshots.ts stateBlob {}), so the section now says so and points at /api/profile-snapshots for the full contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Snapshots are immutable point-in-time metadata records of a\s*\n?profile\. The parent profile keeps evolving — its archetype, name,\s*\n?description,/,
    );
    expect(p).toMatch(/Browser state \(cookies, logins\)\s*\n?is NOT captured at v1/);
  });

  it("CRITICAL snapshot-id prefix 'psnap_' pinned. Drift to a different prefix would break SDK type discriminators.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/The response carries the snapshot's `id` \(prefix `psnap_`\),/);
  });

  it('CRITICAL snapshot list endpoints — per-profile AND cross-profile. /v1/profiles/:id/snapshots (per-profile) + /v1/profile-snapshots (cross-profile, matches W756 dashboard /snapshots).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/profiles\/:id\/snapshots` — newest-first, paginated\./);
    expect(p).toMatch(
      /`GET \/v1\/profile-snapshots` — every snapshot owned by the calling\s*\n?account, across all profiles\./,
    );
  });

  it("CRITICAL snapshot restore creates NEW profile + tier-cap-counted framing pinned. Matches W756 /snapshots restore-form 'counts against your profile tier cap' wording.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Creates a NEW profile carrying the snapshot's `parent_archetype` \+\s*\n?`description`\. The original parent profile is NOT modified/,
    );
    expect(p).toMatch(
      /The\s*\n?new profile counts against your tier cap \(429 if it would exceed\)\s*\n?and 409s on name collision\./,
    );
  });

  it('CRITICAL snapshot restore audit-log payload.restored_from_snapshot pinned. Matches W755 /audit-log V-381 shared-filter framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `audit_log` entry for\s*\n?`profile\.created` carries `payload\.restored_from_snapshot:\s*\n?psnap_<id>`\./,
    );
  });

  it("CRITICAL snapshot-orphans-on-parent-delete framing pinned. S36 2026-07-07 (fable-truth-audit): '+ state remain restorable' → '+ description remain restorable' — no state is ever captured at v1 (stateBlob always {}), so only archetype/name/description survive into a restore. Matches W756 dashboard '(parent profile deleted)' inline indicator.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Deleting the parent profile sets\s*\n?the snapshot's `parent_profile_id` to `null` but does NOT delete\s*\n?the snapshot — the captured `parent_archetype` \+ `parent_name` \+\s*\n?description remain restorable\./,
    );
    // Negative pin — the retired restorable-state fiction must not come back.
    expect(p).not.toMatch(/\+\s*\n?state remain restorable/);
  });

  it("CRITICAL snapshots have no automatic lifecycle pinned. The 'Snapshots have no automatic lifecycle. Capture as many as you want; they sit until you delete them' wording is the load-bearing no-TTL framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Snapshots have no automatic lifecycle\. Capture as many as you want;\s*\n?they sit until you delete them\./,
    );
  });

  it('CRITICAL DELETE profile is a SOFT delete (L4b recycle bin) — moves to trash, recoverable, frees the name, 30-day retention then purge. (Was hard-delete pre-recycle-bin; docs updated to match.)', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Soft-deletes\*\* the profile/);
    expect(p).toContain('recycle bin');
    expect(p).toMatch(/retained for 30 days.*then permanently purged/s);
    // The stale hard-delete claim must be gone.
    expect(p).not.toMatch(/the metadata is hard-deleted, not soft-deleted/);
  });

  it('CRITICAL DELETE idempotent-204 framing pinned (re-deleting an already-trashed profile returns 204, not 404 — 2026-05-31 founder decision, still holds under soft-delete).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Returns `204 No Content`, and is idempotent — re-deleting an already-trashed\s*\n?profile \(or an id that was never yours\) also returns `204`\./,
    );
    // Trash + restore + purge endpoints documented.
    expect(p).toMatch(/`GET \/v1\/profiles\/trash`/);
    expect(p).toMatch(/`POST \/v1\/profiles\/:id\/restore`/);
    expect(p).toMatch(/`DELETE \/v1\/profiles\/:id\/purge`/);
  });

  it('CRITICAL anti-abuse cap framing pinned — trashed profiles STILL count against the cap until purged (2026-06-17); purge frees the slot immediately. The stale "doesn\'t count against your tier\'s profile cap" claim must be gone.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/still counts against your tier's profile cap.*until it's\s*\n?purged/s);
    expect(p).not.toMatch(/doesn't\s*\n?count against your tier's profile cap/);
    // Purge section: permanent + frees the slot + irreversible.
    expect(p).toMatch(/## Purge \(permanent delete\)/);
    expect(p).toMatch(/frees its cap slot\s*\n?immediately/);
    expect(p).toMatch(/\*\*irreversible\*\*/);
  });

  it('CRITICAL 6-endpoint canonical action set pinned — POST + GET-list + GET-one + PATCH + POST-clone + DELETE.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/profiles`/);
    expect(p).toMatch(/`GET \/v1\/profiles\?limit=50&cursor=<\.\.\.>`/);
    expect(p).toMatch(/`GET \/v1\/profiles\/:id`/);
    expect(p).toMatch(/`PATCH \/v1\/profiles\/:id`/);
    expect(p).toMatch(/`POST \/v1\/profiles\/:id\/clone`/);
    expect(p).toMatch(/`DELETE \/v1\/profiles\/:id`/);
  });

  it('CRITICAL 4-endpoint snapshot action set pinned — POST capture + GET list + GET get + POST restore + DELETE.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/profiles\/:id\/snapshots`/);
    expect(p).toMatch(/`GET \/v1\/profile-snapshots\/:id`/);
    expect(p).toMatch(/`POST \/v1\/profile-snapshots\/:id\/restore`/);
    expect(p).toMatch(/`DELETE \/v1\/profile-snapshots\/:id`/);
  });

  it("CRITICAL session-binding lifecycle interaction framing pinned. The 'A session is bound to a profile at creation time (POST /v1/sessions { profile_id }). The session carries the profile\\'s state forward; on destroy, any state mutations are persisted back to the profile row\\'s underlying storage' wording is the canonical session-profile binding contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A session is bound to a profile at creation time\s*\n?\(`POST \/v1\/sessions \{ profile_id \}`\)/,
    );
    expect(p).toMatch(
      /on destroy, any state mutations are\s*\n?persisted back to the profile row's underlying storage\./,
    );
  });

  it("CRITICAL concurrent-sessions-serialised framing pinned. The 'Concurrent sessions on the SAME profile are serialised at the driver layer to avoid state-merge conflicts' wording explains the no-multi-write contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Concurrent\s*\n?sessions on the SAME profile are serialised at the driver layer\s*\n?to avoid state-merge conflicts\./,
    );
  });

  it("CRITICAL team-RBAC admin-required-for-writes framing pinned. The 'member roles cannot write on the owner\\'s account; admin members can' wording matches W757 /team page member-vs-admin contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /member roles cannot write on\s*\n?\s*the owner's account; admin\s*\n?\s*members can\./,
    );
  });

  it("CRITICAL write-scope framing — profile write endpoints require the `write:profiles` scope (NOT `admin`). Matches the route-level requireScope('write:profiles') guard; drift back to 'admin scope' would mis-document the actual gate and mislead least-privilege key minting.", () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /write endpoints \(POST, PATCH, DELETE\) require the `write:profiles`\s*\n?\s*scope on the calling key \(a broad `write` key also satisfies it\)\./,
    );
  });

  it('CRITICAL 404-on-cross-account no-existence-leak framing pinned. The "we don\'t leak existence cross-account" wording is the load-bearing privacy contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Returns 404 if the profile doesn't exist or belongs to a different\s*\n?account \(we don't leak existence cross-account\)\./,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-profiles-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
