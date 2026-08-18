// W1051 — routes/profiles V-081 + V-313 + V-480 + V-326e4 cross-source
// invariant. Pins apps/server/src/routes/profiles.ts:
//
//   V-081 anchor — 'Profile routes — five endpoints under /v1/profiles
//   (V-081)'.
//
//   Endpoint roster — 8 routes (the header says 'five' but 3 more
//   landed in V-313 clone + V-480 export/import):
//     POST   /v1/profiles            — create
//     GET    /v1/profiles            — list (cursor pagination)
//     GET    /v1/profiles/:id        — get
//     PATCH  /v1/profiles/:id        — update
//     DELETE /v1/profiles/:id        — delete
//     POST   /v1/profiles/:id/clone  (V-313)
//     GET    /v1/profiles/:id/export (V-480)
//     POST   /v1/profiles/import     (V-480)
//
//   V-326e4 admin-only-write team gate — 'Profile writes on a team
//   owner require admin role on that team.'
//
//   PROFILE_ID_RE — '^prof_(uuid)$'.
//
//   publicProfile envelope — 7 fields (prof_ id + name + archetype +
//   description + last_used_at ISO|null + created_at + updated_at).
//
//   V-313 clone framing — 'Same admin-only-on-team gate as create.
//   Tier cap is checked server-side (matches the create path); 429 /
//   TierLimit on exceeded. Body `name` optional — server auto-derives
//   a non-conflicting `${source} (copy)` if omitted'.
//
//   V-480 export envelope — version + exported_at ISO + source_profile_id
//   (prof_) + source_account_id + nested profile {name, archetype,
//   description}. Metadata-only; per-profile browser state out of
//   scope for v1.
//
//   PROFILE_EXPORT_ENVELOPE_VERSION imported from @driftstack/api-types
//   (shared with import) — single source of truth for the wire version.
//
//   V-480 import framing — 'Importing into a different account than
//   the source is permitted (transfer between teammate accounts via
//   the file)'.
//
// stays in lockstep across apps/server/src/routes/profiles.ts.

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

describe('W1051 routes/profiles V-081 + V-313 + V-480 + V-326e4 cross-source invariant', () => {
  // ─── V-081 anchor + 8-endpoint roster ────────────────────────

  it("CRITICAL V-081 anchor — 'Profile routes — five endpoints under /v1/profiles (V-081)'. The 'five endpoints' phrase is the original header; V-313 + V-480 supplements landed later as separate sections.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/Profile routes — five endpoints under \/v1\/profiles \(V-081\)\./);
  });

  it('CRITICAL endpoint roster — 5 core (POST/GET/GET-:id/PATCH/DELETE) + 3 supplemental (V-313 clone + V-480 export + V-480 import) + 3 L4b recycle bin (GET trash + POST restore + DELETE purge). 11 total mount sites.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/POST\s+\/v1\/profiles\s+— create \(tier-limit enforced\)/);
    expect(p).toMatch(/GET\s+\/v1\/profiles\s+— list \(cursor pagination\)/);
    expect(p).toMatch(/GET\s+\/v1\/profiles\/:id\s+— get one/);
    expect(p).toMatch(
      /PATCH\s+\/v1\/profiles\/:id\s+— partial update \(name, description, folder, tags\)/,
    );
    expect(p).toMatch(/DELETE \/v1\/profiles\/:id\s+— delete/);
    expect(p).toMatch(/'\/v1\/profiles\/:id\/clone'/);
    expect(p).toMatch(/'\/v1\/profiles\/:id\/export'/);
    expect(p).toMatch(/'\/v1\/profiles\/import'/);
    // L4b recycle bin
    expect(p).toMatch(/'\/v1\/profiles\/trash'/);
    expect(p).toMatch(/'\/v1\/profiles\/:id\/restore'/);
    expect(p).toMatch(/'\/v1\/profiles\/:id\/purge'/);
  });

  // ─── V-326e4 team-RBAC ──────────────────────────────────────

  it("CRITICAL V-326e4 admin-only-write gate — 'Profile writes on a team owner require admin role on that team.' Same 'on that team' phrasing as admin api-keys; canonical team-RBAC write-gate copy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/V-326e4 — admin-only gate for profile write operations on team/);
    expect(p).toMatch(/owners\./);
    expect(p).toMatch(
      /throw new ForbiddenError\('Profile writes on a team owner require admin role on that team\.'\)/,
    );
  });

  // ─── PROFILE_ID_RE ──────────────────────────────────────────

  it("CRITICAL PROFILE_ID_RE — '^prof_(uuid)$' (dedicated regex, not the general PUBLIC_ID_RE family). The single-prefix anchor protects against id-shape drift.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(
      /const PROFILE_ID_RE = \/\^prof_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\//,
    );
    expect(p).toMatch(/'Invalid id format\. Expected "prof_<uuid>"\.'/);
  });

  // ─── publicProfile envelope ─────────────────────────────────

  it("CRITICAL publicProfile envelope — 7 fields (prof_ id / name / archetype / description / last_used_at ISO|null / created_at ISO / updated_at ISO). The 'last_used_at null = never used' semantics is the only nullable field.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/id: `prof_\$\{p\.id\}`,/);
    expect(p).toMatch(/name: p\.name,/);
    expect(p).toMatch(/archetype: p\.archetype,/);
    expect(p).toMatch(/description: p\.description,/);
    expect(p).toMatch(/last_used_at: p\.lastUsedAt \? p\.lastUsedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/created_at: p\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: p\.updatedAt\.toISOString\(\),/);
  });

  // ─── V-313 clone ─────────────────────────────────────────────

  it("CRITICAL V-313 clone framing — 'Same admin-only-on-team gate as create. Tier cap is checked server-side (matches the create path); 429 / TierLimit on exceeded (V-814 corrected the status). Body `name` optional — server auto-derives a non-conflicting `${source} (copy)` if omitted'. The auto-derived-name design lets the dashboard's right-click 'Duplicate' work without a confirmation modal.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/Same admin-only-on-team gate as create\. Tier cap is checked/);
    expect(p).toMatch(/server-side \(matches the create path\); 429 \/ TierLimit on/);
    expect(p).toMatch(/exceeded\. Body `name` optional — server auto-derives a non-/);
    expect(p).toMatch(/conflicting `\$\{source\} \(copy\)` if omitted\./);
  });

  // ─── V-480 export envelope ──────────────────────────────────

  it("CRITICAL V-480 export envelope — 5 fields (version / exported_at ISO / source_profile_id prof_ / source_account_id / nested profile {name, archetype, description}). The version field anchors a v2-extension story: 'Metadata-only JSON export. Per-profile browser state lives driver-side and is out of scope for v1; the envelope is versioned so a v2 that extends to driver state stays back-compat'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/Metadata-only JSON export\. Per-profile browser state lives driver-/);
    expect(p).toMatch(/side and is out of scope for v1; the envelope is versioned so a v2/);
    expect(p).toMatch(/that extends to driver state stays back-compat\./);
    expect(p).toMatch(/version: PROFILE_EXPORT_ENVELOPE_VERSION,/);
    expect(p).toMatch(/exported_at: new Date\(\)\.toISOString\(\),/);
    expect(p).toMatch(/source_profile_id: `prof_\$\{row\.id\}`,/);
    expect(p).toMatch(/source_account_id: row\.accountId,/);
  });

  it("CRITICAL nested 'profile' object in export — {name, archetype, description}. The 3-field nested object is the metadata-only contract; drift to flat-spreading those fields would break export-import round-trip parity.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(
      /profile: \{\s*\n?\s*name: row\.name,\s*\n?\s*archetype: row\.archetype,\s*\n?\s*description: row\.description,\s*\n?\s*\},/,
    );
  });

  // ─── V-480 import framing ───────────────────────────────────

  it("CRITICAL V-480 import framing — 'Accepts a v1 envelope, mints a fresh profile in the caller's account. Tier-cap + name-conflict semantics match POST /v1/profiles. Importing into a different account than the source is permitted (transfer between teammate accounts via the file)'. The cross-account permit is the teammate-transfer use case.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/Accepts a v1 envelope, mints a fresh profile in the caller's/);
    expect(p).toMatch(/account\. Tier-cap \+ name-conflict semantics match POST \/v1\/profiles\./);
    expect(p).toMatch(/Importing into a different account than the source is permitted/);
    expect(p).toMatch(/\(transfer between teammate accounts via the file\)\./);
  });

  // ─── x-driftstack-account header ────────────────────────────

  it("CRITICAL EFFECTIVE_ACCOUNT_HEADER — 'x-driftstack-account'. Extracted to shared lib/effective-account-header.ts; profiles + profile-snapshots + admin all import readEffectiveAccountHeader from there for V-326e team-RBAC consistency.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/effective-account-header.ts'));
    expect(lib).toMatch(/export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/);
  });

  // ─── Auth + rate-limit on every route ───────────────────────

  it('CRITICAL requireAuth + global rate-limit on every profile route; write:profiles on the 8 mutations (incl. L4b restore + purge).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    // Count requireAuth + rateLimit('global') independently — the
    // mutations now carry app.requireScope('write:profiles') between
    // them (V-481 scope enforcement), so the old adjacent-pair regex no
    // longer matches those routes. 11 routes now (8 + L4b trash/restore/purge).
    // Was `>= 11` for both, against a file that has 13 routes — two spare, and
    // the title says "every route". Measured: dropping one requireAuth left 13
    // and all 12 arms here passed. A bound with slack cannot see a route added
    // without the gate, nor one that loses it.
    //
    // The roster is derived and compared for PARITY instead: one requireAuth and
    // one global rate-limit per registered route. The preHandler anchor keeps the
    // file's own header comment (which names both) out of the count.
    // Comments are stripped first: this file's own header names both gates in
    // prose, and counting that sentence as a gate is what let the old bound look
    // satisfied.
    const code = p
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const routes = code.match(/^\s*app\.(?:get|post|patch|put|delete)[<(]/gm) ?? [];
    expect(routes.length, 'the derived route roster must not collapse').toBeGreaterThanOrEqual(13);
    const authRefs = code.match(/app\.requireAuth/g) ?? [];
    expect(authRefs.length, 'requireAuth on every route').toBe(routes.length);
    const rateRefs = code.match(/app\.rateLimit\('global'\)/g) ?? [];
    expect(rateRefs.length, 'global rate-limit on every route').toBe(routes.length);
    // write:profiles on the 9 mutations: create, update, delete, clone,
    // import, transfer, restore (L4b), purge (L4b), trim (doc-150 §8 storage
    // eviction). Trash-list is read-only.
    const scopeRefs = p.match(/app\.requireScope\('write:profiles'\)/g) ?? [];
    expect(scopeRefs.length, 'write:profiles on the profile mutations').toBe(9);
  });

  // ─── 204 on delete ───────────────────────────────────────────

  it('CRITICAL DELETE /v1/profiles/:id → 204 No Content. The RFC-conformant idempotent-delete response.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts'));
    expect(p).toMatch(/return reply\.code\(204\)\.send\(\);/);
  });
});
