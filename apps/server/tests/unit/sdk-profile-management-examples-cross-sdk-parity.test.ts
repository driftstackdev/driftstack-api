// W801 — cross-SDK profile-management-example parity. One-hundred-
// twenty-seventh in the drift-guard series. Pins the persistent-
// profile surface end-to-end demo (V-073 + V-312 + V-313) in
// lockstep across sdk-typescript / sdk-python / sdk-go. Drift in
// the 8-step ordering would create an example that leaks created
// resources (cleanup skipped) or visits steps in an unsafe order.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/profile-management.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/examples/profile_management.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/examples/profile_management/main.go');

describe('W801 cross-SDK profile-management examples parity', () => {
  it('all 3 profile-management example files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Header framing — profile-state + Manual-ladder + ADR-004 ──

  it("CRITICAL profiles-as-persistent-browser-state-slots framing pinned in TS + Python. The 'cookies, localStorage, IndexedDB' + 'Sessions can attach to a profile to resume a logged-in state across runs' wording is the load-bearing 'what profiles are' teaching anchor.", () => {
    expect(read(TS)).toMatch(
      /Profiles are persistent browser-state slots: cookies, localStorage,\s*\n\/\/ IndexedDB\. Sessions can attach to a profile to resume a logged-in\s*\n\/\/ state across runs\./,
    );
    expect(read(PY)).toMatch(
      /Profiles are persistent browser-state slots: cookies, localStorage,\s*\nIndexedDB\. Sessions can attach to a profile to resume a logged-in\s*\nstate across runs\./,
    );
  });

  it("CRITICAL Manual-ladder + API-ladder cap framing pinned in TS + Python — 'Personal = 10, Team = 50, Agency = 200' + 'the API ladder also caps profiles per ADR-004'. Drift would lose the canonical profile-count-as-tier-metric anchor.", () => {
    expect(read(TS)).toMatch(/Personal = 10, Team = 50, Agency\s*\n\/\/ Manual = 200/);
    expect(read(TS)).toMatch(/the API ladder also caps profiles per ADR-004/);
    expect(read(PY)).toMatch(/Personal = 10, Team = 50, Agency\s*\nManual = 200/);
    expect(read(PY)).toMatch(/the API ladder also caps profiles per ADR-004/);
  });

  it('CRITICAL V-073 (anchor) header line pinned in TS only. The "V-073 profiles surface end-to-end" wording in line 1 of the TS example threads the V-073 provenance to the canonical example file.', () => {
    expect(read(TS)).toMatch(/\/\/ Profile management — V-073 profiles surface end-to-end\./);
  });

  it('CRITICAL Go header pins the 8-step walk + V-313 + V-312 anchors. The single-line "create → list → get → update → clone (V-313) → snapshot capture (V-312) → snapshot restore → cleanup" is the load-bearing flow contract.', () => {
    expect(read(GO)).toMatch(
      /Walks the persistent-profile surface end-to-end: create →\s*\n\/\/ list → get → update → clone \(V-313\) → snapshot capture \(V-312\) →\s*\n\/\/ snapshot restore → cleanup\./,
    );
  });

  // ─── V-136 LOCKED_ARCHETYPE_ID server-default ─────────────────

  it("CRITICAL V-136 LOCKED_ARCHETYPE_ID server-default framing pinned in TS + Python (per-tier since P-15, 2026-09-05). The 'Archetype defaults server-side to your tier's device if omitted … (V-136 LOCKED_ARCHETYPE_ID), the newest iPhone 13 on the free tier' wording explains why the create call omits archetype.", () => {
    expect(read(TS)).toMatch(
      /Archetype defaults server-side to your tier's\s*\n\s*\/\/\s+device if omitted: the locked iPhone 17 \/ iOS 18\.7 \/ Safari 26\.4\s*\n\s*\/\/\s+surface on tiers entitled to every device \(V-136 LOCKED_ARCHETYPE_ID\),\s*\n\s*\/\/\s+the newest iPhone 13 on the free tier\./,
    );
    expect(read(PY)).toMatch(
      /Archetype defaults server-side to your tier's\s*\n\s*#\s+device if omitted: the locked iPhone 17 \/ iOS 18\.7 \/ Safari 26\.4\s*\n\s*#\s+surface on tiers entitled to every device \(V-136 LOCKED_ARCHETYPE_ID\),\s*\n\s*#\s+the newest iPhone 13 on the free tier\./,
    );
  });

  // ─── D-032 name-uniqueness scope (TS only — most complete) ────

  it("CRITICAL D-032 name-uniqueness scope framing pinned in TS + Python. 'Profile-name uniqueness is scoped to (account_id, name) per D-032' is the load-bearing constraint anchor; drift would lose the explanation for the 409 path.", () => {
    expect(read(TS)).toMatch(
      /Profile-name uniqueness\s*\n\s*\/\/\s+is scoped to \(account_id, name\) per D-032/,
    );
    expect(read(PY)).toMatch(
      /Profile-name uniqueness\s*\n\s*#\s+is scoped to \(account_id, name\) per D-032/,
    );
  });

  // ─── V-313 clone + auto-derived "(copy)" naming ───────────────

  it('CRITICAL V-313 clone-with-auto-derived-(copy)-naming framing pinned cross-SDK. TS: \'Server auto-derives "(copy)" / "(copy 2)" / ... naming when no name is supplied\' + Python: \'Server auto-derives "(copy)" naming when no body is supplied\' + Go: \'V-313 clone — server auto-derives "(copy)" naming\'. Drift would lose the canonical clone-naming contract.', () => {
    expect(read(TS)).toMatch(
      /V-313 — clone the profile\. Server auto-derives "\(copy\)" \/\s*\n\s*\/\/\s+"\(copy 2\)" \/ \.\.\. naming when no name is supplied/,
    );
    expect(read(PY)).toMatch(
      /V-313 — clone the profile\. Server auto-derives "\(copy\)"\s*\n\s*#\s+naming when no body is supplied\./,
    );
    expect(read(GO)).toMatch(/\/\/ 5\. V-313 clone — server auto-derives "\(copy\)" naming\./);
  });

  // ─── V-312 snapshot capture + frozen-parent framing ───────────

  it("CRITICAL V-312 snapshot capture + 'frozen point-in-time copy' framing pinned cross-SDK. TS: 'V-312 — capture an immutable point-in-time snapshot of the parent profile. The snapshot is frozen; the parent keeps evolving' + Python: 'V-312 — capture an immutable point-in-time snapshot' + Go: 'V-312 snapshot capture — frozen point-in-time copy'. Drift would lose the canonical immutability anchor.", () => {
    expect(read(TS)).toMatch(
      /V-312 — capture an immutable point-in-time snapshot of the\s*\n\s*\/\/\s+parent profile\. The snapshot is frozen; the parent keeps\s*\n\s*\/\/\s+evolving\./,
    );
    expect(read(PY)).toMatch(/V-312 — capture an immutable point-in-time snapshot\./);
    expect(read(GO)).toMatch(/\/\/ 6\. V-312 snapshot capture — frozen point-in-time copy\./);
  });

  // ─── Snapshot restore creates NEW profile, parent unmodified ──

  it("CRITICAL snapshot-restore-creates-NEW-profile-parent-unmodified framing pinned in TS + Python. The 'Restore the snapshot into a NEW profile. The original parent profile is never modified' wording (capitalized NEW) is the load-bearing 'restore is non-destructive' contract.", () => {
    expect(read(TS)).toMatch(
      /Restore the snapshot into a NEW profile\. The original parent\s*\n\s*\/\/\s+profile is never modified\./,
    );
    expect(read(PY)).toMatch(
      /Restore the snapshot into a NEW profile\. The original parent\s*\n\s*#\s+profile is never modified\./,
    );
    expect(read(GO)).toMatch(/Restore the snapshot into a NEW profile\./);
  });

  // ─── Snapshots have no automatic lifecycle ────────────────────

  it("CRITICAL TS-only 'Snapshots have no automatic lifecycle' framing pinned. The 'capture as many as you want, delete when you no longer need them' wording explains the snapshot-cost model and prevents storage runaway from the example.", () => {
    expect(read(TS)).toMatch(
      /Snapshots have no\s*\n\s*\/\/\s+automatic lifecycle; capture as many as you want, delete\s*\n\s*\/\/\s+when you no longer need them\./,
    );
  });

  // ─── 8-step ordering enforced cross-SDK ───────────────────────

  it('CRITICAL 8-step flow ordering — create → list/iterate → get → update → clone → snapshot capture → snapshot restore → cleanup — enforced cross-SDK via index positions. Drift would either leak resources or visit steps in an unsafe order (e.g. cloning AFTER cleanup).', () => {
    function indices(p: string, markers: RegExp[]): number[] {
      return markers.map((m) => {
        const i = p.search(m);
        expect(i, `marker not found: ${m}`).toBeGreaterThan(-1);
        return i;
      });
    }

    const tsIdx = indices(read(TS), [
      /client\.profiles\.create\(\{/,
      /client\.profiles\.iterate\(/,
      /client\.profiles\.get\(/,
      /client\.profiles\.update\(/,
      /client\.profiles\.clone\(/,
      /client\.profileSnapshots\.capture\(/,
      /client\.profileSnapshots\.restore\(/,
      /client\.profileSnapshots\.delete\(/,
    ]);
    const pyIdx = indices(read(PY), [
      /client\.profiles\.create\(/,
      /client\.profiles\.iterate\(/,
      /client\.profiles\.get\(/,
      /client\.profiles\.update\(/,
      /client\.profiles\.clone\(/,
      /client\.profile_snapshots\.capture\(/,
      /client\.profile_snapshots\.restore\(/,
      /client\.profile_snapshots\.delete\(/,
    ]);
    const goIdx = indices(read(GO), [
      /client\.Profiles\.Create\(/,
      /client\.Profiles\.Iterate\(/,
      /client\.Profiles\.Get\(/,
      /client\.Profiles\.Update\(/,
      /client\.Profiles\.Clone\(/,
      /client\.ProfileSnapshots\.Capture\(/,
      /client\.ProfileSnapshots\.Restore\(/,
      /client\.ProfileSnapshots\.Delete\(/,
    ]);

    for (const idx of [tsIdx, pyIdx, goIdx]) {
      for (let i = 0; i < idx.length - 1; i++) {
        expect(idx[i]).toBeLessThan(idx[i + 1]!);
      }
    }
  });

  // ─── Pagination uses iterate() with limit=50 cross-SDK ────────

  it('CRITICAL pagination uses iterate() with limit:50 cross-SDK. TS: client.profiles.iterate({ limit: 50 }) + Python: client.profiles.iterate(limit=50) + Go: client.Profiles.Iterate(ctx, &ListProfilesQuery{Limit: 50}, ...). The 50-per-page default matches W798 cross-SDK pagination convention.', () => {
    expect(read(TS)).toMatch(/client\.profiles\.iterate\(\{ limit: 50 \}\)/);
    expect(read(PY)).toMatch(/client\.profiles\.iterate\(limit=50\)/);
    expect(read(GO)).toMatch(
      /client\.Profiles\.Iterate\(ctx, &driftstack\.ListProfilesQuery\{Limit: 50\}/,
    );
  });

  // ─── Snapshot capture: label='baseline' ───────────────────────

  it("CRITICAL snapshot label='baseline' literal pinned cross-SDK. The 'baseline' label is the canonical first-snapshot-name convention from the docs page; drift would lose the docs/example parallelism.", () => {
    expect(read(TS)).toMatch(/label: 'baseline'/);
    expect(read(PY)).toMatch(/"label": "baseline"/);
    expect(read(GO)).toMatch(/Label: +"baseline"/);
  });

  // ─── Cleanup: snapshot first then profiles (FK-safe order) ────

  it('CRITICAL cleanup ordering — snapshot deleted FIRST then profiles. The order is FK-safe (snapshots reference their parent profile); deleting profiles first would either fail with 409 or orphan snapshots. Pinned across all 3 SDKs.', () => {
    function snapshotBeforeProfileDelete(
      p: string,
      snapMarker: RegExp,
      profMarker: RegExp,
    ): boolean {
      const s = p.search(snapMarker);
      const f = p.search(profMarker);
      expect(s, `snapshot delete marker not found: ${snapMarker}`).toBeGreaterThan(-1);
      expect(f, `profile delete marker not found: ${profMarker}`).toBeGreaterThan(-1);
      return s < f;
    }

    expect(
      snapshotBeforeProfileDelete(
        read(TS),
        /client\.profileSnapshots\.delete\(/,
        /client\.profiles\.delete\(/,
      ),
    ).toBe(true);
    expect(
      snapshotBeforeProfileDelete(
        read(PY),
        /client\.profile_snapshots\.delete\(/,
        /client\.profiles\.delete\(/,
      ),
    ).toBe(true);
    expect(
      snapshotBeforeProfileDelete(
        read(GO),
        /client\.ProfileSnapshots\.Delete\(/,
        /client\.Profiles\.Delete\(/,
      ),
    ).toBe(true);
  });

  // ─── Demo-name pattern: demo-{timestamp} ──────────────────────

  it("CRITICAL demo-name pattern 'demo-{timestamp}' pinned cross-SDK. TS: `demo-${Date.now()}` + Python: f'demo-{int(time.time())}' + Go: fmt.Sprintf('demo-%d', time.Now().Unix()). The timestamp suffix avoids the D-032 (account_id, name) conflict when the example is re-run.", () => {
    expect(read(TS)).toMatch(/`demo-\$\{Date\.now\(\)\.toString\(\)\}`/);
    expect(read(PY)).toMatch(/f"demo-\{int\(time\.time\(\)\)\}"/);
    expect(read(GO)).toMatch(/fmt\.Sprintf\("demo-%d", time\.Now\(\)\.Unix\(\)\)/);
  });

  // ─── -renamed + -restored name suffix conventions ─────────────

  it("CRITICAL '-renamed' + '-restored' name-suffix conventions pinned cross-SDK. The literal suffixes thread the example's progress through demo output (so users see how the names evolve through update→restore). Drift would lose the demo's pedagogical readability.", () => {
    expect(read(TS)).toMatch(/\$\{created\.name\}-renamed/);
    expect(read(TS)).toMatch(/\$\{updated\.name\}-restored/);
    expect(read(PY)).toMatch(/\{created\['name'\]\}-renamed/);
    expect(read(PY)).toMatch(/\{updated\['name'\]\}-restored/);
    expect(read(GO)).toMatch(/created\.Name \+ "-renamed"/);
    expect(read(GO)).toMatch(/updated\.Name \+ "-restored"/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-profile-management-examples-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
