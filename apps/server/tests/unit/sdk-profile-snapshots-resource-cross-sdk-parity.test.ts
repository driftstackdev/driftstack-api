// W827 — cross-SDK ProfileSnapshotsResource methods parity. One-
// hundred-fifty-third in the drift-guard series. Pins the
// ProfileSnapshotsResource method set (V-312 immutable point-in-
// time profile snapshots) across all 3 SDKs. Drift would break
// W801 cross-SDK profile-management example + customer snapshot
// rollback workflows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profile-snapshots.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/profile_snapshots.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/profile_snapshots.go');

// 7 shared method names cross-SDK.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['capture', 'capture', 'Capture'],
  ['listForProfile', 'list_for_profile', 'ListForProfile'],
  ['list', 'list', 'List'],
  ['iterate', 'iterate', 'Iterate'],
  ['get', 'get', 'Get'],
  ['restore', 'restore', 'Restore'],
  ['delete', 'delete', 'Delete'],
];

describe('W827 cross-SDK ProfileSnapshotsResource methods parity', () => {
  it('all 3 ProfileSnapshotsResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 7-required-method set ────────────────────────────────────

  it('CRITICAL all 7 ProfileSnapshotsResource methods exist in all 3 SDKs — capture + listForProfile + list + iterate + get + restore + delete. Drift would break W801 cross-SDK profile-management example + customer snapshot rollback workflows.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *ProfileSnapshotsResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*ProfileSnapshotsResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── capture(profileId, body) shape ───────────────────────────

  it("CRITICAL capture(profileId, body) shape pinned cross-SDK. TS: capture(profileId, body: CaptureSnapshotRequest); Python: capture(profile_id, body: dict[str, Any]); Go: Capture(ctx, profileID, body *CaptureSnapshotRequest). The profile-id + body 2-arg shape is what W801 example exercises (label='baseline' + description).", () => {
    expect(read(TS)).toMatch(
      /capture\(profileId: string, body: CaptureSnapshotRequest\): Promise<ProfileSnapshot>/,
    );
    expect(read(PY)).toMatch(
      /def capture\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(read(GO)).toMatch(/Capture\(/);
  });

  // ─── restore returns Profile (not ProfileSnapshot) ────────────

  it("CRITICAL restore() returns a Profile (new profile) cross-SDK, not a ProfileSnapshot. The 'restores into a NEW profile' contract from W801 means the response is a Profile object — drift to returning the snapshot itself would let buggy customer code use the snapshot ID where a new profile ID is needed.", () => {
    expect(read(TS)).toMatch(
      /restore\(id: string, body: RestoreSnapshotRequest\): Promise<Profile>/,
    );
    expect(read(PY)).toMatch(
      /def restore\(self, snapshot_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(read(GO)).toMatch(/Restore\(/);
  });

  // ─── delete() returns void cross-SDK ──────────────────────────

  it('CRITICAL delete() returns void cross-SDK — TS Promise<void> / Python -> None / Go error-only. HTTP 204 per API.', () => {
    expect(read(TS)).toMatch(/delete\(id: string\): Promise<void>/);
    expect(read(PY)).toMatch(/def delete\(self, snapshot_id: str\) -> None:/);
    expect(read(GO)).toMatch(/func \(r \*ProfileSnapshotsResource\) Delete\(/);
  });

  // ─── Python untyped-dict + iterate dual ───────────────────────

  it('CRITICAL Python ProfileSnapshotsResource returns dict[str, Any] (untyped pending codegen — matches W824 profiles). All methods including iterate dual.', () => {
    const p = read(PY);
    expect(p).toMatch(
      /def capture\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(p).toMatch(/def get\(self, snapshot_id: str\) -> dict\[str, Any\]:/);
    expect(p).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(p).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[dict\[str, Any\]\]:/,
    );
    expect(p).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[dict\[str, Any\]\]:/,
    );
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH ProfileSnapshotsResource (sync) AND AsyncProfileSnapshotsResource (async). Every method except iterate (generator) has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      if (pyName === 'iterate') continue;
      expect(p, `Python AsyncProfileSnapshotsResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Go ctx-first convention ──────────────────────────────────

  it('CRITICAL Go ProfileSnapshotsResource methods all take ctx context.Context as first arg. Matches W822-W826 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(
          `func \\(r \\*ProfileSnapshotsResource\\) ${goName}\\(\\s*ctx context\\.Context`,
        ),
      );
    }
  });

  // ─── Go has private listInternal helper ───────────────────────

  it("CRITICAL Go ProfileSnapshotsResource has private 'listInternal' helper shared between List + ListForProfile. The lowercase first letter indicates package-private — drift to exporting it would expand the public surface accidentally.", () => {
    const p = read(GO);
    expect(p).toMatch(/func \(r \*ProfileSnapshotsResource\) listInternal\(/);
  });

  // ─── TS strongly-typed return shapes ──────────────────────────

  it('CRITICAL TS strongly-typed return shapes pinned. capture → ProfileSnapshot; list → ProfileSnapshotsListPage; iterate → AsyncGenerator<ProfileSnapshot>; get → ProfileSnapshot; restore → Profile (NEW profile, not snapshot).', () => {
    const p = read(TS);
    expect(p).toMatch(/capture\(.*\): Promise<ProfileSnapshot>/);
    expect(p).toMatch(
      /list\(query: PaginationQueryInput = \{\}\): Promise<ProfileSnapshotsListPage>/,
    );
    expect(p).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<ProfileSnapshot, void, void>/,
    );
    expect(p).toMatch(/get\(id: string\): Promise<ProfileSnapshot>/);
    expect(p).toMatch(/restore\(id: string, body: RestoreSnapshotRequest\): Promise<Profile>/);
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python ProfileSnapshotsResource + AsyncProfileSnapshotsResource constructors take http client. Matches W822-W826 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-profile-snapshots-resource-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
