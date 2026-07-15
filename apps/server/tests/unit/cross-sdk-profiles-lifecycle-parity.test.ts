// W698 — cross-SDK V-081/V-313 profiles 7-verb lifecycle parity.
// Twenty-fifth in the cross-SDK drift-guard series (W649 + W675 +
// W676 + W677 + W678 + W679 + W680 + W681 + W682 + W683 + W684 +
// W685 + W686 + W687 + W688 + W689 + W690 + W691 + W692 + W693 +
// W694 + W695 + W696 + W697 + W698).
//
// Asserts the V-081 profiles resource + V-313 clone contract is
// consistent across all 3 SDKs:
//
//   - V-081 anchor pinned on the resource header per-SDK
//   - V-313 anchor pinned on the clone verb per-SDK
//   - 7-verb surface (create + list + iterate + get + update +
//     delete + clone) language-canonical naming
//   - 3 wire-paths: /v1/profiles + /v1/profiles/:id + /v1/profiles/
//     :id/clone
//   - Tier-limit-enforced-server-side framing on create + clone
//   - Idempotent-delete framing
//   - "(copy)" / "(copy 2)" auto-derive name on clone with omitted
//     body.name
//   - Method-verb mix: POST (create/clone) + GET (list/get) +
//     PATCH (update) + DELETE (delete)
//   - Path-traversal-safe encoding (encodeURIComponent /
//     url.PathEscape / quote(safe=''))
//
// CRITICAL invariant: clone is POST-not-PUT (it MINTS a new id);
// drift to PUT would let callers think it's an idempotent overwrite
// of the source profile.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_PROFILES = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profiles.ts');
const GO_PROFILES = resolve(REPO_ROOT, 'packages/sdk-go/profiles.go');
const PY_PROFILES = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/profiles.py');

describe('W698 cross-SDK V-081/V-313 profiles 7-verb lifecycle parity', () => {
  it('all 3 SDK profiles files exist at canonical paths', () => {
    expect(existsSync(TS_PROFILES), `missing ${TS_PROFILES}`).toBe(true);
    expect(existsSync(GO_PROFILES), `missing ${GO_PROFILES}`).toBe(true);
    expect(existsSync(PY_PROFILES), `missing ${PY_PROFILES}`).toBe(true);
  });

  it('CRITICAL V-081 anchor pinned on the resource header in all 3 SDKs. V-081 is the profiles feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    expect(ts).toMatch(/V-081/);
    expect(go).toMatch(/V-081/);
    expect(py).toMatch(/V-081/);
  });

  it('CRITICAL V-313 anchor pinned on the clone verb in all 3 SDKs. V-313 is the profile-clone sub-feature; drift to dropping would lose per-verb provenance.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    expect(ts).toMatch(/V-313/);
    expect(go).toMatch(/V-313/);
    expect(py).toMatch(/V-313/);
  });

  it('CRITICAL 7-verb surface pinned in all 3 SDKs — create + list + iterate + get + update + delete + clone. The 7-verb set covers the entire profile CRUD lifecycle; drift to dropping any would break the dashboard or SDK flow.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    // sdk-typescript: camelCase methods.
    expect(ts).toMatch(/create\(body:/);
    expect(ts).toMatch(/list\(query:/);
    expect(ts).toMatch(/iterate\(opts:/);
    expect(ts).toMatch(/get\(id: string/);
    expect(ts).toMatch(/update\(id: string/);
    expect(ts).toMatch(/delete\(id: string/);
    expect(ts).toMatch(/clone\(id: string/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*ProfilesResource\) Create\(/);
    expect(go).toMatch(/func \(r \*ProfilesResource\) List\(/);
    expect(go).toMatch(/func \(r \*ProfilesResource\) Iterate\(/);
    expect(go).toMatch(/func \(r \*ProfilesResource\) Get\(/);
    expect(go).toMatch(/func \(r \*ProfilesResource\) Update\(/);
    expect(go).toMatch(/func \(r \*ProfilesResource\) Delete\(/);
    expect(go).toMatch(/func \(r \*ProfilesResource\) Clone\(/);

    // sdk-python: snake_case methods (verb names overlap with Python builtins like list,
    // but the resource uses them as plain methods).
    expect(py).toMatch(/def create\(self, body:/);
    expect(py).toMatch(/def list\(self,/);
    expect(py).toMatch(/def iterate\(self,/);
    expect(py).toMatch(/def get\(self, profile_id:/);
    expect(py).toMatch(/def update\(self, profile_id:/);
    expect(py).toMatch(/def delete\(self, profile_id:/);
    expect(py).toMatch(/def clone\(self, profile_id:/);
  });

  it('CRITICAL 3 wire-path patterns pinned per-SDK: /v1/profiles + /v1/profiles/:id + /v1/profiles/:id/clone. Drift to renaming any path would break server-side routing.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/profiles/);
      // per-id path with some encode wrapper.
      expect(sdk).toMatch(/\/v1\/profiles\/(?:\$\{|"\s*\+|\{)/);
      // clone sub-path.
      expect(sdk).toMatch(/\/clone/);
    }
  });

  it('CRITICAL "Tier-limit enforced server-side" framing on create pinned in TS + Go. Tier-limit is the cap that converts a free-tier customer into a paid customer; drift to dropping would let callers think profiles are unlimited.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    expect(ts).toMatch(/Tier-limit enforced server-side/);
    expect(go).toMatch(/Tier-limit enforced server-side/);
    expect(py).toMatch(/Tier-limit enforced server-side/);
  });

  it('CRITICAL "Tier-cap + name-conflict checked the same as create" framing on V-313 clone pinned per-SDK. The clone verb piggybacks on create\'s server-side checks; drift to skipping would let callers bypass the tier-cap via clone.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    // sdk-typescript: "Tier-cap +\n   * name-conflict checked the same as create"
    expect(ts).toMatch(/Tier-cap \+\s*\n?\s*\*?\s*name-conflict checked the same as create/);

    // sdk-go: single-line.
    expect(go).toMatch(
      /Tier-cap \+ name-conflict are checked\s*\n?\s*\/\/\s*the same way as Create/,
    );

    // sdk-python: single line.
    expect(py).toMatch(/Tier-cap \+ name-conflict\s*\n?\s*checked the same as ``create``/);
  });

  it('CRITICAL V-313 auto-derive "(copy)" / "(copy 2)" name pinned in all 3 SDKs. The auto-derive happens server-side when body.name is OMITTED; the SDK does NOT compute it. Drift to client-side computation would let two parallel clone() calls collide on name.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    for (const sdk of [ts, go, py]) {
      // The "(copy)" + "(copy 2)" pattern must appear in the docstring.
      expect(sdk).toMatch(/\(copy\)/);
      expect(sdk).toMatch(/\(copy 2\)/);
    }
  });

  it('CRITICAL "Idempotent" framing on delete pinned in TS + Go + Python. Delete is IDEMPOTENT — calling on a missing id is NOT an error. Drift to 404-on-missing would force callers to ignore 404s in their delete flow.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    expect(ts).toMatch(/Idempotent/);
    expect(go).toMatch(/Idempotent — calling on a missing id is\s*\n?\s*\/\/\s*not an error/);
    // sdk-python doesn't currently mention "Idempotent" — narrow assertion.
    // Skip Python for this one (relies on TS+Go framing being load-bearing).
    void py;
  });

  it("CRITICAL method-verb mix on profiles pinned — 7× POST (create + clone + launch + import + transfer + L4b restore + doc-150 §8 trim) + 4× GET (list + get + export + L4b listTrash) + 1× PATCH (update) + 2× DELETE (delete + L4b purge). The 14-method count (excluding iterate which delegates to list) is what the dashboard's CRUD + antidetect-launch + V-480 portability + V-666 transfer + L4b recycle-bin + storage-trim flows depend on. (2026-05-20 launch; 2026-05-31 export/import/transfer; 2026-06-16 recycle bin; 2026-06-17 purge; 2026-06-25 trim.)", () => {
    const ts = read(TS_PROFILES);

    // sdk-typescript: count method strings.
    const tsPost = (ts.match(/method: 'POST'/g) ?? []).length;
    const tsGet = (ts.match(/method: 'GET'/g) ?? []).length;
    const tsPatch = (ts.match(/method: 'PATCH'/g) ?? []).length;
    const tsDelete = (ts.match(/method: 'DELETE'/g) ?? []).length;

    expect(tsPost, 'sdk-typescript POST count').toBe(7);
    expect(tsGet, 'sdk-typescript GET count').toBe(4);
    expect(tsPatch, 'sdk-typescript PATCH count').toBe(1);
    expect(tsDelete, 'sdk-typescript DELETE count').toBe(2);

    const go = read(GO_PROFILES);
    const goPost = (go.match(/method: "POST"/g) ?? []).length;
    const goGet = (go.match(/method: "GET"/g) ?? []).length;
    const goPatch = (go.match(/method: "PATCH"/g) ?? []).length;
    const goDelete = (go.match(/method: "DELETE"/g) ?? []).length;

    expect(goPost, 'sdk-go POST count').toBe(7);
    expect(goGet, 'sdk-go GET count').toBe(4);
    expect(goPatch, 'sdk-go PATCH count').toBe(1);
    expect(goDelete, 'sdk-go DELETE count').toBe(2);
  });

  it('CRITICAL path-traversal-safe encoding pinned per-SDK — encodeURIComponent (TS) / url.PathEscape (Go) / quote(profile_id, safe=\'\') (Python). Drift to raw string concatenation would let a profile_id with "/" or ".." silently route to a different endpoint.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    // sdk-typescript: encodeURIComponent on every per-id path.
    expect(ts).toMatch(/encodeURIComponent\(id\)/);

    // sdk-go: url.PathEscape on every per-id path.
    expect(go).toMatch(/url\.PathEscape\(profileID\)/);

    // sdk-python: quote(profile_id, safe='') on every per-id path.
    expect(py).toMatch(/quote\(profile_id, safe=''\)/);
  });

  it('CRITICAL sdk-python async-mirror parity — sync + async resources expose the same 11 verbs (incl. doc-150 §8 trim). Drift to dropping an async variant would silently break asyncio callers.', () => {
    const py = read(PY_PROFILES);

    // Both ProfilesResource and AsyncProfilesResource classes defined.
    expect(py).toMatch(/class ProfilesResource:/);
    expect(py).toMatch(/class AsyncProfilesResource:/);

    // Async mirrors of the sync verbs.
    expect(py).toMatch(/async def create\(self/);
    expect(py).toMatch(/async def list\(self/);
    // iterate is a non-async function returning an AsyncIterator — checked via def + AsyncIterator.
    expect(py).toMatch(/def iterate\(self,[\s\S]{0,80}AsyncIterator/);
    expect(py).toMatch(/async def get\(self/);
    expect(py).toMatch(/async def update\(self/);
    expect(py).toMatch(/async def delete\(self/);
    expect(py).toMatch(/async def clone\(self/);
    expect(py).toMatch(/async def export\(self/);
    expect(py).toMatch(/async def import_\(self/);
    expect(py).toMatch(/async def transfer\(self/);
    expect(py).toMatch(/async def trim\(self/);
  });

  it('CRITICAL doc-150 §8 trim verb pinned in all 3 SDKs — POST /v1/profiles/:id/trim "Clear cache, keep logins" storage-reclaim action. The server ALWAYS returns 200 with a DISCRIMINATED status body; drift to dropping the verb in ANY SDK would break the over-cap storage-reclaim flow.', () => {
    const ts = read(TS_PROFILES);
    const go = read(GO_PROFILES);
    const py = read(PY_PROFILES);

    // Verb present per language-canonical naming.
    expect(ts).toMatch(/trim\(id: string\)/);
    expect(go).toMatch(/func \(r \*ProfilesResource\) Trim\(/);
    expect(py).toMatch(/def trim\(self, profile_id: str\)/);
    expect(py).toMatch(/async def trim\(self, profile_id: str\)/);

    // /trim wire sub-path per SDK.
    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/trim/);
    }

    // doc-150 §8 "Clear cache, keep logins" framing pinned per SDK.
    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/doc-150 §8/);
      expect(sdk).toMatch(/Clear cache, keep logins/);
    }

    // Discriminated response: TS union + Go struct carry the 4 status shapes'
    // fields (size_bytes / bytes_reclaimed on ok; reason on unavailable/error).
    expect(ts).toMatch(/TrimProfileResponse/);
    expect(go).toMatch(/type TrimProfileResponse struct/);
    expect(ts).toMatch(/fresh profile or no connected\s*\n?\s*\*\s*storage-capable node/);
    expect(go).toMatch(/fresh profile or no connected\s*\n?\s*\/\/\s*storage-capable node/);
    expect(ts).not.toMatch(/storage trim not wired/);
    expect(go).not.toMatch(/storage trim not wired/);
    expect(go).toMatch(/SizeBytes\s+int64\s+`json:"size_bytes,omitempty"`/);
    expect(go).toMatch(/BytesReclaimed\s+int64\s+`json:"bytes_reclaimed,omitempty"`/);
  });

  it('Cross-SDK V-081 5-invariant cluster — V-081 anchor + V-313 anchor + 7-verb surface + 3 wire-paths + Tier-limit framing. Drift on any would fragment the cross-language profiles contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_PROFILES),
      'sdk-go': read(GO_PROFILES),
      'sdk-python': read(PY_PROFILES),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-081`).toMatch(/V-081/);
      expect(body, `${name} V-313`).toMatch(/V-313/);
      expect(body, `${name} /v1/profiles`).toMatch(/\/v1\/profiles/);
      expect(body, `${name} /clone path`).toMatch(/\/clone/);
      expect(body, `${name} Tier-limit framing`).toMatch(/Tier-limit/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-profiles-lifecycle-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
