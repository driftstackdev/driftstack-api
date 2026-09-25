// Drift guard for apps/docs/src/pages/api/account.md.
// Pins the /me-ignores-team-RBAC invariant + the response-shape
// table + the slug constraint + the avatar size limit.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/account content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Account/);
    expect(body).toMatch(/description: Read \+ edit the calling account/);
  });

  it("/me-ignores-team-RBAC invariant pinned: /me always operates on caller's own account, even when caller has admin role on team owner. Drift would silently route /me to the owner's data instead of the team member's own — a confidentiality leak in the team-RBAC contract", () => {
    expect(body).toMatch(
      /never\s+honours the team-RBAC `X-Driftstack-Account` header, even when the\s+caller has admin role on a team owner's account/,
    );
    expect(body).toMatch(/even when the\s+caller has admin role on a team owner's account/);
  });

  it('CRITICAL the /me self-only rule is SCOPED, not blanket. `98d767a73` made the nested `/v1/account/me/organization` resource honour the selected effective account, because folders and tags must stay with the profiles they organize. The identity resource and its avatar mutations remain self-only. Pinning either half alone lets the page drift into a confidentiality leak (identity routed to the owner) or a broken GUI (taxonomy stuck on the actor).', () => {
    const body = read(PAGE);
    expect(body).toMatch(/This self-only\s+rule also covers its avatar mutations\./);
    expect(body).toMatch(
      /The nested\s+`\/v1\/account\/me\/organization` profile-taxonomy resource is an\s+explicit exception: it honours the selected effective account/,
    );
  });

  it('response-shape table covers the 14 surface fields (sampling the most-customer-cited ones to detect a row-drop): drift to dropping `mfa_enrolled` would orphan the security header indicator; drift to dropping `teams` would break team-RBAC UX in customer dashboards', () => {
    expect(body).toMatch(/\| `mfa_enrolled`/);
    expect(body).toMatch(/\| `concurrent_session_cap`/);
    expect(body).toMatch(/\| `profile_cap`/);
    expect(body).toMatch(/\| `teams`/);
    expect(body).toMatch(/\| `slug`/);
    expect(body).toMatch(/\| `region`/);
    expect(body).toMatch(/\| `avatar_url`/);
  });

  it("slug constraint pinned: 3-32 chars + lowercase a-z + 0-9 + hyphen + no leading/trailing hyphen + no consecutive hyphens + 409 on collision (drift to widening would break uniqueness assumptions in other surfaces; drift to narrowing would break customers' existing slugs)", () => {
    expect(body).toMatch(
      /`slug` — 3-32 chars, lowercase a-z \+ 0-9 \+ hyphen, no leading or trailing hyphen, no consecutive hyphens\./,
    );
    expect(body).toMatch(/Returns `409 Conflict` when another account already owns the slug/);
  });

  it('avatar upload constraints pinned: 3 content types + 2 MiB raw size + 3.5 MiB body limit (the 1.75x envelope-overhead allowance is the load-bearing reason for the asymmetric raw/body limits — drift to dropping the explanation would orphan customers from understanding why uploads fail at-2MiB)', () => {
    expect(body).toMatch(/`image\/png`, `image\/jpeg`, `image\/webp`/);
    expect(body).toMatch(/Max raw size: 2 MiB/);
    expect(body).toMatch(/route body limit is 3\.5 MiB to allow the base64 envelope/);
  });

  it('avatar DELETE erasure framing, corrected by security sweep E-23. V-797 had the page say the image file is not deleted and a shared link keeps working, which was true then. The delete now removes the image itself, and a replacement removes the old one, so the page must say that; the 503 the route now returns when storage refuses is the other half a client has to handle.', () => {
    expect(body).toMatch(
      /`DELETE \/v1\/account\/me\/avatar` removes your uploaded image and\s*\n?deletes it, so a link to it stops working/,
    );
    expect(body, 'the failure a client must handle is stated').toMatch(
      /fails with `503` and your\s*\n?avatar stays set/,
    );
    expect(body, 'a replacement deletes the previous image').toMatch(
      /Uploading a new image replaces the previous one, which is\s*\n?deleted/,
    );
    expect(body, 'the retired "not deleted" claim must not return').not.toMatch(
      /image file itself is not deleted|keeps\s*\n?working|Do not treat the delete as an erasure/,
    );
    expect(body, 'the phantom garbage collector must not return').not.toMatch(
      /a sweeper job collects orphaned keys/,
    );
  });
});
