// W1048 — routes/profile-snapshots V-312 + V-326e team-RBAC cross-source
// invariant. Pins apps/server/src/routes/profile-snapshots.ts:
//
//   V-312 anchor — 'V-312 — profile snapshot routes'.
//
//   Endpoint roster — 6 routes:
//     POST   /v1/profiles/:id/snapshots          — capture
//     GET    /v1/profiles/:id/snapshots          — list per-profile
//     GET    /v1/profile-snapshots               — list per-account
//     GET    /v1/profile-snapshots/:id           — get one
//     POST   /v1/profile-snapshots/:id/restore   — fresh profile from snapshot
//     DELETE /v1/profile-snapshots/:id           — hard-delete
//
//   Founder Tier-2 verdict framing — 'The snapshot is an immutable
//   point-in-time copy of the parent profile's metadata (per founder
//   Tier-2 verdict 2026-05-09); the parent keeps evolving
//   independently. Restore creates a NEW profile row carrying the
//   snapshot's archetype + a customer-supplied name'.
//
//   x-driftstack-account header — team RBAC effective-account
//   resolution (V-326e); writes require role admin, reads accept
//   member.
//
//   PUBLIC_ID_RE — '^[a-z]+_(uuid-with-dashes)$' (laxer than
//   admin-incidents because the prefix can be 4+ chars: psnap_,
//   prof_, etc.).
//
//   publicSnapshot envelope — 8 fields including psnap_ id +
//   parent_profile_id prof_-prefixed + parent_archetype +
//   parent_name + captured_at + created_at.
//
//   List envelope shape — { data, has_more, next_cursor } shared
//   across the 2 list routes.
//
//   Snapshot writes that target a team owner require admin role
//   ('Snapshot writes on a team owner require admin role.').
//
// stays in lockstep across apps/server/src/routes/profile-snapshots.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1048 routes/profile-snapshots V-312 + V-326e cross-source invariant', () => {
  // ─── V-312 anchor + 6-endpoint roster ────────────────────────

  it("CRITICAL V-312 anchor — 'V-312 — profile snapshot routes'. The single-anchor design ties the surface to the snapshot family.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/V-312 — profile snapshot routes\./);
  });

  it('CRITICAL endpoint roster — 6 routes (capture / list-per-profile / list-per-account / get / restore / delete). The exhaustive header comment is the canonical contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/POST\s+\/v1\/profiles\/:id\/snapshots\s+— capture a snapshot/);
    expect(p).toMatch(
      /GET\s+\/v1\/profiles\/:id\/snapshots\s+— list per-profile \(cursor-paginated\)/,
    );
    expect(p).toMatch(/GET\s+\/v1\/profile-snapshots\s+— list per-account \(across all profiles\)/);
    expect(p).toMatch(/GET\s+\/v1\/profile-snapshots\/:id\s+— get one/);
    expect(p).toMatch(
      /POST\s+\/v1\/profile-snapshots\/:id\/restore\s+— create a fresh profile from snapshot/,
    );
    expect(p).toMatch(/DELETE \/v1\/profile-snapshots\/:id\s+— hard-delete the snapshot/);
  });

  // ─── Founder Tier-2 verdict framing ──────────────────────────

  it("CRITICAL founder Tier-2 verdict framing — 'The snapshot is an immutable point-in-time copy of the parent profile's metadata (per founder Tier-2 verdict 2026-05-09); the parent keeps evolving independently. Restore creates a NEW profile row carrying the snapshot's archetype + a customer-supplied name'. The immutable-copy design + restore-creates-NEW-row decision is the load-bearing semantics.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/The snapshot is an immutable point-in-time copy of the parent/);
    expect(p).toMatch(/profile's metadata \(per founder Tier-2 verdict 2026-05-09\); the/);
    expect(p).toMatch(/parent keeps evolving independently\. Restore creates a NEW profile/);
    expect(p).toMatch(/row carrying the snapshot's archetype \+ a customer-supplied name\./);
  });

  // ─── x-driftstack-account header (V-326e) ────────────────────

  it("CRITICAL EFFECTIVE_ACCOUNT_HEADER — 'x-driftstack-account'. Extracted to shared lib/effective-account-header.ts; profile-snapshots imports readEffectiveAccountHeader from there. The exact header name is the contract for team-RBAC effective-account resolution; drift would break customer-dashboard team-switch UI.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/effective-account-header.ts'));
    expect(lib).toMatch(/export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/);
  });

  it("CRITICAL write-requires-admin — 'Snapshot writes on a team owner require admin role.' The forbidden error message is the canonical team-RBAC write-gate message.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(
      /throw new ForbiddenError\('Snapshot writes on a team owner require admin role\.'\)/,
    );
  });

  it('CRITICAL effectiveAccountIdForWrite — non-team caller returns undefined; team caller with non-admin role throws. The 3-branch decision (non-team / team-admin / team-non-admin) is the canonical V-326e write-gate flow.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/function effectiveAccountIdForWrite\(\s*\n?\s*request: FastifyRequest,/);
    expect(p).toMatch(/if \(eff\.kind !== 'team'\) return undefined;/);
    expect(p).toMatch(/if \(eff\.role !== 'admin'\) \{/);
  });

  // ─── PUBLIC_ID_RE shape ──────────────────────────────────────

  it("CRITICAL PUBLIC_ID_RE — '^[a-z]+_(uuid)$'. Note: laxer than admin-incidents (3-char floor) because profile-snapshots use 5-char prefix (psnap_).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/const PUBLIC_ID_RE = \/\^\[a-z\]\+_\(\[0-9a-fA-F-\]\{36\}\)\$\//);
  });

  // ─── publicSnapshot envelope ─────────────────────────────────

  it('CRITICAL publicSnapshot envelope — 8 fields (psnap_ id / parent_profile_id prof_-prefixed or null / label / description / parent_archetype / parent_name / captured_at ISO / created_at ISO). The dual-prefix design (psnap_ + prof_) lets clients route from snapshot back to the parent profile.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/id: `psnap_\$\{s\.id\}`,/);
    expect(p).toMatch(
      /parent_profile_id: s\.parentProfileId \? `prof_\$\{s\.parentProfileId\}` : null,/,
    );
    expect(p).toMatch(/label: s\.label,/);
    expect(p).toMatch(/description: s\.description,/);
    expect(p).toMatch(/parent_archetype: s\.parentArchetype,/);
    expect(p).toMatch(/parent_name: s\.parentName,/);
    expect(p).toMatch(/captured_at: s\.capturedAt\.toISOString\(\),/);
    expect(p).toMatch(/created_at: s\.createdAt\.toISOString\(\),/);
  });

  // ─── Shared list envelope ────────────────────────────────────

  it('CRITICAL list response envelope — { data: [...publicSnapshot], has_more, next_cursor }. The 3-field shape is shared across list-per-profile + list-per-account so clients use one paginator.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/data: page\.data\.map\(publicSnapshot\),/);
    expect(p).toMatch(/has_more: page\.hasMore,/);
    expect(p).toMatch(/next_cursor: page\.nextCursor,/);
  });

  // ─── PUBLIC_ID_RE uuidFromPrefixedId ─────────────────────────

  it('CRITICAL uuidFromPrefixedId — same error message format as admin-incidents (\'Invalid id format. Expected "<prefix>_<uuid>".\'). Cross-route consistency for the prefix-uuid family.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(
      /throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\)/,
    );
  });

  // ─── Auth+rate-limit on every route ──────────────────────────

  it('CRITICAL requireAuth + global rate-limit on every snapshot route. Drift to dropping either would expose the surface to anonymous or unrate-limited callers.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    const refs = p.match(/preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\]/g) ?? [];
    expect(refs.length, 'requireAuth + global rate-limit chain count').toBeGreaterThanOrEqual(6);
  });

  // ─── Capture payload shape ───────────────────────────────────

  it('CRITICAL capture body — label (required) + description (optional spread). The conditional spread keeps description out of the service call when undefined.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts'));
    expect(p).toMatch(/label: parsed\.data\.label,/);
    expect(p).toMatch(
      /\.\.\.\(parsed\.data\.description !== undefined \? \{ description: parsed\.data\.description \} : \{\}\),/,
    );
  });
});
