// W782 — apps/docs guides/profile-management.md content parity. One-
// hundred-eighth in the cross-SDK drift-guard series.
//
// /guides/profile-management is the canonical persistent-identity
// guide. Drift to the archetype-stickiness contract or the
// what-persists/what-doesn't catalog would mismatch W763 + W774
// /api/profiles + profile-snapshots references and W752 dashboard
// /profiles + W756 /snapshots surfaces.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/profile-management.md');

describe('W782 docs /guides/profile-management content parity', () => {
  it('guides/profile-management.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Profile management\n/,
    );
    expect(p).toMatch(
      /description: Persistent profiles in Driftstack — create, list, reuse across sessions, and delete\. How profiles relate to archetypes and tier limits\./,
    );
  });

  it("CRITICAL persistent-identity framing pinned. The 'A profile is a persistent identity Driftstack maintains across sessions. Cookies, local storage, IndexedDB, and the WebKit-fork\\'s stealth state survive between session lifetimes when a session binds to a profile' wording matches W763 /api/profiles + W752 dashboard /profiles + W780 guides index TOC.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A \*\*profile\*\* is a persistent identity Driftstack maintains across sessions\. Cookies, local storage, IndexedDB, and the WebKit-fork's stealth state survive between session lifetimes when a session binds to a profile\./,
    );
  });

  it("CRITICAL ephemeral-when-no-profile framing pinned. The 'If a session doesn\\'t bind a profile, it starts ephemeral — fresh cookies, fresh storage, no continuity. That\\'s the right choice for one-shot fetches' wording matches W752 /profiles dashboard + W781 session-lifecycle no-profile contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /If a session doesn't bind a profile, it starts ephemeral — fresh cookies, fresh storage, no continuity\. That's the right choice for one-shot fetches\./,
    );
  });

  it("CRITICAL 8-tier profile cap table pinned. Matches W763 /api/profiles + W769 /api/usage + W752 dashboard tier-cap tables. Note: docs guide uses 'API Builder 100' (not 200 anymore — single source from PROFILES_PER_TIER).", () => {
    const p = read(PAGE);

    const tierCaps: Array<[string, string]> = [
      ['Free', '1'],
      ['Personal', '10'],
      ['Team', '50'],
      ['Agency', '200'],
      ['API Starter', '25'],
      ['API Builder', '100'],
      ['API Scale', '500'],
      ['Enterprise', 'Custom'],
    ];
    for (const [tier, cap] of tierCaps) {
      expect(p, `${tier} → ${cap}`).toMatch(new RegExp(`\\| ${tier}\\s+\\|\\s+${cap}\\s+\\|`));
    }
  });

  it("CRITICAL 429 RFC 9457 tier-limit-error framing pinned. The 'Exceeding the cap returns 429 with an RFC 9457 https://errors.driftstack.dev/tier-limit problem body — the detail string names the tier and the cap' wording matches W776 /sdk/error-handling RFC 7807 hierarchy.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Exceeding the cap returns `429` with an RFC 9457 `https:\/\/errors\.driftstack\.dev\/tier-limit` problem body — the `detail` string names the tier and the cap\./,
    );
  });

  it("CRITICAL self-hosted-tiers-fleet-cap framing pinned. The 'Self-hosted tiers don\\'t enforce per-account profile caps — they enforce concurrent-session caps + archetype counts at the fleet level instead' wording explains the multi-deployment difference.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Self-hosted tiers don't enforce per-account profile caps — they enforce concurrent-session caps \+ archetype counts at the fleet level instead\./,
    );
  });

  it('CRITICAL LOCKED_ARCHETYPE_ID iphone17_ios18_7_safari26_4 framing pinned (post-2026-06-11 cutover). Matches W763 + W774 + W761 archetype default contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `archetype` field is optional and defaults to the locked archetype \(`iphone17_ios18_7_safari26_4` — current iPhone 17 on iOS 18\.7 with Safari 26\.4\)\./,
    );
    expect(p).toMatch(
      /Pin to an older archetype only if you have a behavioural-stability reason\./,
    );
  });

  it('CRITICAL 3-language SDK examples pinned — TypeScript + Python + Go. All call profiles.create with the same body shape (name + description).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/await client\.profiles\.create\(\{/);
    expect(p).toMatch(/client\.profiles\.create\(\{/);
    expect(p).toMatch(/client\.Profiles\.Create\(ctx, &driftstack\.CreateProfileRequest\{/);

    // Common body fields.
    expect(p).toMatch(/name: 'shopper-account-1',/);
    expect(p).toMatch(/Name:\s+"shopper-account-1",/);
  });

  it("CRITICAL prof_-prefix id + name-unique-409 framing pinned. The 'name is unique within an account. Re-using a name returns 409 Conflict' wording matches W763 server-side validation.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/"id": "prof_01HV\.\.\."/);
    expect(p).toMatch(
      /`name` is unique within an account\. Re-using a name returns `409 Conflict`\./,
    );
  });

  it('2026-05-20 — profile-to-session binding flipped planned→SHIPPED (fa8cb83a). Doc now pins the wired POST /v1/sessions profile_id field, the cross-account 404 anti-enumeration framing, and the profiles.launch() one-shot helper.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`POST \/v1\/sessions` accepts an optional `profile_id` field as of 2026-05-20 \(commit `fa8cb83a`\)\./,
    );
    expect(p).toMatch(/profile_id: 'prof_01HV\.\.\.',/);
    expect(p).toMatch(
      /Cross-account `profile_id` returns `404` \(anti-enumeration — indistinguishable from a missing one\)\./,
    );
  });

  it('2026-05-20 — Launch one-shot helper section pins SDK-level profiles.launch() + dashboard /profiles per-row Launch CTA + state inheritance flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/## Launch a profile \(one-shot\)/);
    expect(p).toMatch(
      /the SDK exposes `profiles\.launch\(id, body\?\)` as a one-round-trip alternative to `sessions\.create\(\{ profile_id \}\)`:/,
    );
    expect(p).toMatch(
      /The dashboard `\/profiles` page exposes a per-row \*\*Launch\*\* button that calls this endpoint/,
    );
    expect(p).toMatch(
      /Profile-bound sessions inherit the profile's storage state on launch and write new state back on clean destroy/,
    );
  });

  it('uses the live archetype default and present-tense saved-proxy egress contracts', () => {
    const p = read(PAGE);

    expect(p).toContain('[`GET /v1/archetypes`](/api/archetypes/)');
    expect(p).toMatch(
      /clients should read it at runtime instead of predicting or constructing a slug/,
    );
    expect(p).toMatch(/intentionally have no per-session egress field/);
    expect(p).toContain('client.agentSessions.create({ proxy_id })');
    expect(p).not.toMatch(
      /when iOS 18\.8 ships|does not support customer-configurable egress yet|execution backend has no driver-layer proxy plumbing|real device fleet/i,
    );
  });

  it('CRITICAL profile-delete framing pinned (L4b recycle bin): soft-delete → recycle bin → 30-day restore → purge; idempotent 204; still no `force` flag (the route never implemented one). Stale "Permanent — storage state is wiped" framing removed.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Soft-delete — the profile moves to a \*\*recycle bin\*\*/);
    expect(p).toMatch(/restorable for 30 days/);
    expect(p).toMatch(
      /there's no `force` flag, and re-deleting an already-trashed profile still returns `204`/,
    );
    expect(p).not.toMatch(/Permanent — storage state is wiped/);
  });

  it("CRITICAL clone-not-cloning-storage framing pinned. The 'Underlying storage state is NOT cloned — the new profile starts with a fresh state slot under the same archetype' wording matches W763 /api/profiles clone-fresh-state.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Underlying storage state is NOT cloned — the new profile starts with a fresh state slot under the same archetype\./,
    );
  });

  it('CRITICAL clone audit-log payload.cloned_from + profile_-prefix asymmetry framing pinned. The \'audit-log entry for the new profile carries payload.cloned_from: "profile_<uuid>" (the internal profile_ prefix\' wording matches W774 + W768 /api/audit-log V-381 profile_/psnap_ prefix asymmetry note.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The audit-log entry for the new profile carries `payload\.cloned_from: "profile_<uuid>"` \(the internal `profile_` prefix; see \[audit-log payload reference\]\(\/api\/audit-log\/#payload-reference\) for the format\)\./,
    );
  });

  it("CRITICAL clone tier-cap + name-conflict + 404-not-yours error trio pinned. The '429 if your tier limit would be exceeded, 409 on explicit-name collision, 404 if the source profile isn\\'t yours or doesn\\'t exist' wording matches W763 + W774 server-side validation.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Tier-cap \+ name-conflict are checked the same way as `create`: 429 if your tier limit would be exceeded, 409 on explicit-name collision, 404 if the source profile isn't yours or doesn't exist\./,
    );
  });

  it("CRITICAL snapshot-is-immutable framing pinned. The 'A snapshot is a frozen copy of a profile. The parent profile keeps evolving — its name, description, and storage state mutate as you use it. The snapshot does not' wording matches W774 + W763 + W756 dashboard /snapshots immutable framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /A snapshot is a frozen copy of a profile\. The parent profile keeps evolving — its name, description, and storage state mutate as you use it\. The snapshot does not\./,
    );
  });

  it('CRITICAL psnap_-id prefix + parent_archetype/parent_name frozen-at-capture framing pinned. Matches W774 /api/profile-snapshots capture-shape contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/snap\.id — "psnap_<uuid>"/);
    expect(p).toMatch(/snap\.parent_archetype, snap\.parent_name — frozen at capture time/);
  });

  it("CRITICAL restore-creates-NEW-profile framing pinned. The 'Creates a NEW profile (the original is never modified)' + audit-log payload.restored_from_snapshot with psnap_ public-prefix matches W774 + W768 audit-log + W756 dashboard /snapshots.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Creates a NEW profile \(the original is never modified\)\./);
    expect(p).toMatch(
      /The audit-log entry on the new profile carries `payload\.restored_from_snapshot: "psnap_<uuid>"` \(the public `psnap_` prefix; see \[audit-log payload reference\]\(\/api\/audit-log\/#payload-reference\)\)\./,
    );
  });

  it("CRITICAL snapshots-no-automatic-lifecycle + orphan-on-parent-delete framing pinned, and V-752 requires the state_blob-is-always-empty warning: the old wording promised 'state stay restorable' while capture() hardcodes stateBlob:{} — a customer could delete a parent profile believing the snapshot held its logins.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Snapshots have no automatic lifecycle\. Capture as many as you want; they sit until you delete them\./,
    );
    // Was "Deleting the parent profile sets `parent_profile_id` to `null`", which is false for
    // the customer-visible DELETE — that is a soft delete into the recycle bin, and the FK is
    // onDelete 'set null', firing only at hard purge. The page already said so, but only in a
    // parenthetical at the end of the following paragraph, which is about browser state.
    expect(p).toMatch(
      /Deleting the parent profile keeps the snapshot — the captured `parent_archetype`, `parent_name`, and `description` remain restorable\./,
    );
    expect(p).toMatch(/only becomes `null` at hard purge/);
    // V-752 — the destructive misreading this guards: "state stay restorable" invited a
    // customer to delete the parent. profile-snapshots.ts:135 writes `stateBlob: {}` and
    // restore reads only parentArchetype + description, so no browser state ever existed.
    // The sibling API reference (api/profiles.md) was already corrected to "description";
    // this guide was the surface that got missed.
    expect(p).toMatch(/A snapshot does NOT preserve browser state/);
    expect(p).toMatch(/always written empty in v1, and restore never reads it/);
    expect(p).toMatch(/that data is not recoverable from one/);
    expect(p).not.toMatch(/and state stay restorable/);
  });

  it("CRITICAL cross-SDK profile_snapshots access framing pinned. The 'The same surface is available in the Python and Go SDKs as client.profile_snapshots.* and client.ProfileSnapshots.* respectively' wording matches W777 SDK versioning cross-SDK lockstep contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The same surface is available in the Python and Go SDKs as `client\.profile_snapshots\.\*` and `client\.ProfileSnapshots\.\*` respectively\./,
    );
  });

  it("CRITICAL profile-name no-PII-no-secrets framing pinned. The 'Names ARE visible in the dashboard and any team-member access logs. Don\\'t put PII or secrets in profile names; use description for human notes if you need them' wording is the load-bearing privacy customer-guidance.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Names ARE visible in the dashboard and any team-member access logs\. Don't put PII or secrets in profile names; use `description` for human notes if you need them\./,
    );
  });

  it("CRITICAL archetype-stable-for-lifetime framing pinned. The 'Profiles pin to one archetype at creation time. The pin is stable: a profile created against iphone16pro_ios18_7_safari26_4 keeps that fingerprint forever, even after the locked default rolls forward. This stability is intentional — re-using a profile shouldn\\'t surprise downstream behavioural-detection systems with a sudden iOS bump' wording matches W763 /api/profiles archetype-is-sticky-for-lifetime contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Profiles pin to one archetype at creation time\. The pin is stable: a profile created against `iphone16pro_ios18_7_safari26_4` keeps that fingerprint forever, even after the locked default rolls forward\./,
    );
    expect(p).toMatch(
      /This stability is intentional — re-using a profile shouldn't surprise downstream behavioural-detection systems with a sudden iOS bump\./,
    );
  });

  it('CRITICAL 5-storage-persists catalog pinned. cookies + localStorage/sessionStorage + IndexedDB + Service Worker + Cache Storage + WebKit-fork stealth state. The 5-bullet list explains what crosses session boundaries.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /HTTP cookies \(incl\. `Secure`, `HttpOnly`, `SameSite` attributes; partition keys preserved\)\./,
    );
    expect(p).toMatch(
      /WebStorage: `localStorage` and `sessionStorage` \(per-origin partitions\)\./,
    );
    expect(p).toMatch(/IndexedDB databases \(per-origin partitions\)\./);
    expect(p).toMatch(
      /Service Worker registrations \+ Cache Storage entries \(per-origin partitions\)\./,
    );
    expect(p).toMatch(
      /The WebKit-fork's stealth state \(canvas\/font\/audio noise seeds — re-used across sessions to keep the fingerprint stable\)\./,
    );
  });

  it('CRITICAL 3-NOT-persisted catalog pinned. DOM tree + active WebSocket/EventSource + WebRTC peer connections. The 3-bullet list explains the connection-state-not-carried contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The DOM tree of the last page \(sessions always start with a fresh page\)\./,
    );
    expect(p).toMatch(
      /Active WebSocket \/ EventSource connections \(open a fresh one on the next session\)\./,
    );
    expect(p).toMatch(/WebRTC peer connections\./);
  });

  it('CRITICAL Next-steps 3-link set pinned — /guides/session-lifecycle/ + /api/versioning/ + /webhooks/events/.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*\[Session lifecycle\]\(\/guides\/session-lifecycle\/\)\*\*/);
    expect(p).toMatch(/\*\*\[API versioning\]\(\/api\/versioning\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Webhook events\]\(\/webhooks\/events\/\)\*\*/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-guides-profile-management-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
