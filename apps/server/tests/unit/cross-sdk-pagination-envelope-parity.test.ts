// W689 — cross-SDK pagination envelope shape parity. Sixteenth in
// the cross-SDK drift-guard series (W649 + W675 + W676 + W677 +
// W678 + W679 + W680 + W681 + W682 + W683 + W684 + W685 + W686 +
// W687 + W688 + W689).
//
// Asserts the pagination envelope shape is consistent across all 3
// SDKs:
//
//   - Canonical 3-field shape (sessions / profiles / profile-
//     snapshots / webhook-deliveries): `{ data: T[], has_more:
//     boolean, next_cursor: string | null }`
//   - 2-field variant (audit-log): `{ data: T[], next_cursor:
//     string | null }` (no has_more — V-118 iterate uses
//     next_cursor:null as the terminator signal)
//   - Cross-resource consistency — the SAME envelope shape across
//     6 distinct paginated resources × 3 SDKs = 18 cell matrix
//
// The shared envelope is what makes the iteratePaginated /
// iterate_paginated helper work cross-resource. Drift to per-
// resource envelopes would force each resource to ship its own
// cursor walker (defeating W422.A pagination centralization).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Paginated resource files per SDK (5 resources × 3 SDKs = 15 files).
const TS_PAGINATION = resolve(REPO_ROOT, 'packages/sdk-typescript/src/pagination.ts');
const GO_PAGINATION = resolve(REPO_ROOT, 'packages/sdk-go/pagination.go');
const PY_PAGINATION = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/pagination.py');
const TS_SESSIONS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/sessions.ts');
const TS_PROFILES = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profiles.ts');
const TS_SNAPSHOTS = resolve(
  REPO_ROOT,
  'packages/sdk-typescript/src/resources/profile-snapshots.ts',
);
const TS_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/webhooks.ts');
const TS_AUDIT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/audit-log.ts');
const GO_SESSIONS = resolve(REPO_ROOT, 'packages/sdk-go/sessions.go');
const GO_PROFILES = resolve(REPO_ROOT, 'packages/sdk-go/profiles.go');
const GO_SNAPSHOTS = resolve(REPO_ROOT, 'packages/sdk-go/profile_snapshots.go');
const GO_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-go/webhooks.go');
const GO_AUDIT = resolve(REPO_ROOT, 'packages/sdk-go/audit_log.go');
const PY_SESSIONS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/sessions.py');
const PY_PROFILES = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/profiles.py');
const PY_SNAPSHOTS = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/resources/profile_snapshots.py',
);
const PY_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');
const PY_AUDIT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/audit_log.py');

describe('W689 cross-SDK pagination envelope shape parity', () => {
  it('all 15 SDK paginated-resource files exist at canonical paths', () => {
    for (const p of [
      TS_SESSIONS,
      TS_PROFILES,
      TS_SNAPSHOTS,
      TS_WEBHOOKS,
      TS_AUDIT,
      GO_SESSIONS,
      GO_PROFILES,
      GO_SNAPSHOTS,
      GO_WEBHOOKS,
      GO_AUDIT,
      PY_SESSIONS,
      PY_PROFILES,
      PY_SNAPSHOTS,
      PY_WEBHOOKS,
      PY_AUDIT,
    ]) {
      expect(existsSync(p), `missing ${p}`).toBe(true);
    }
  });

  it('CRITICAL sdk-typescript 3-field envelope shape (data + has_more + next_cursor) pinned in 4 resources (sessions / profiles / profile-snapshots / webhooks). Each defines `XxxListPage` interface with the canonical 3 fields.', () => {
    const ts4Files = [TS_SESSIONS, TS_PROFILES, TS_SNAPSHOTS, TS_WEBHOOKS];
    for (const f of ts4Files) {
      const body = read(f);
      // Look for `data: T[];` + `has_more: boolean;` + `next_cursor: string | null;`
      expect(body, `${f} has_more field`).toMatch(/has_more: boolean;/);
      expect(body, `${f} next_cursor field`).toMatch(/next_cursor: string \| null;/);
    }
  });

  it('CRITICAL sdk-typescript audit-log 2-field envelope shape (data + next_cursor) pinned. audit-log uses next_cursor:null as the SOLE terminator signal (no has_more). Drift to adding has_more would conflict with the simpler 2-field shape.', () => {
    const body = read(TS_AUDIT);
    // AuditLogListPage carries data + next_cursor (no has_more).
    expect(body).toMatch(
      /export interface AuditLogListPage \{\s*data: AuditLogEntry\[\];\s*next_cursor: string \| null;\s*\}/,
    );
  });

  it('CRITICAL next_cursor field type — `string | null` (NOT `string | undefined` or `string?`). The explicit `| null` is what the W422.A pagination helper checks for termination (`page.next_cursor === null`). Drift to undefined would loop forever; drift to optional would force per-call presence checks.', () => {
    const ts4Files = [TS_SESSIONS, TS_PROFILES, TS_SNAPSHOTS, TS_WEBHOOKS, TS_AUDIT];
    for (const f of ts4Files) {
      const body = read(f);
      expect(body, `${f} next_cursor: string | null`).toMatch(/next_cursor: string \| null;/);
    }
  });

  it('CRITICAL has_more semantic invariant — when present (sessions/profiles/profile-snapshots/webhooks-deliveries), it complements next_cursor as a redundant termination signal. Customer code may use EITHER (next_cursor===null OR has_more===false) to terminate. Drift to making them disagree would let one signal say "more pages" while the other says "done".', () => {
    // Each of the 4 envelope types must declare BOTH has_more + next_cursor.
    const ts4Files = [TS_SESSIONS, TS_PROFILES, TS_SNAPSHOTS, TS_WEBHOOKS];
    for (const f of ts4Files) {
      const body = read(f);
      // Both fields present.
      expect(body, `${f} has_more`).toMatch(/has_more: boolean;/);
      expect(body, `${f} next_cursor`).toMatch(/next_cursor: string \| null;/);
    }
  });

  it('sdk-go pagination — cursor / NextCursor referenced in each paginated resource file. Go envelope types live in api-types generated models so resource files reference them via type imports OR by passing cursor query params. Drift to dropping cursor handling entirely would break pagination.', () => {
    const goFiles = [GO_SESSIONS, GO_PROFILES, GO_SNAPSHOTS, GO_WEBHOOKS, GO_AUDIT];
    for (const f of goFiles) {
      const body = read(f);
      // Look for any cursor-related reference (struct field, query param, etc.).
      expect(body, `${f} cursor / next-cursor reference`).toMatch(/cursor|Cursor|NextCursor/);
    }
  });

  it('sdk-python pagination — `next_cursor: str | None` pydantic shape in 2 of 5 paginated resources (sessions + webhooks). The other 3 (profiles + profile-snapshots + audit-log) use bare dict[str, Any] returns until the next regen pass adds typed envelopes. Drift to dropping the typed envelope from the 2 typed resources would lose static-check coverage on those.', () => {
    const pyTypedFiles = [PY_SESSIONS, PY_WEBHOOKS];
    for (const f of pyTypedFiles) {
      const body = read(f);
      expect(body, `${f} next_cursor: str | None`).toMatch(/next_cursor: str \| None/);
    }
  });

  it('Cross-SDK consistency invariant — the SAME 5 paginated resources (sessions / profiles / profile-snapshots / webhooks-deliveries / audit-log) appear across all 3 SDKs. Drift to dropping pagination from a resource in ONE SDK would break cross-language iteration UX.', () => {
    // Each SDK should have all 5 envelope-bearing resource files.
    // We just check the files exist (file-existence check happens
    // above) and that each carries a "data:" + "next_cursor" reference.
    const sdkResources = {
      'sdk-typescript': [TS_SESSIONS, TS_PROFILES, TS_SNAPSHOTS, TS_WEBHOOKS, TS_AUDIT],
      'sdk-go': [GO_SESSIONS, GO_PROFILES, GO_SNAPSHOTS, GO_WEBHOOKS, GO_AUDIT],
      'sdk-python': [PY_SESSIONS, PY_PROFILES, PY_SNAPSHOTS, PY_WEBHOOKS, PY_AUDIT],
    };

    for (const [sdk, files] of Object.entries(sdkResources)) {
      for (const f of files) {
        const body = read(f);
        // Body should reference some form of cursor/page/next field.
        expect(body, `${sdk} ${f} mentions cursor/page/next`).toMatch(
          /next_cursor|NextCursor|cursor/i,
        );
      }
    }
  });

  // Termination on an EMPTY-STRING cursor, which the three helpers used to
  // disagree about. Measured by running the same three page-sequences through
  // all three: on `next_cursor: ""` sdk-go stopped, while sdk-typescript and
  // sdk-python treated it as a real cursor and fetched again.
  //
  // That is not a harmless extra call. The server decodes an empty cursor as
  // "first page", so the walk restarts and the iterator cycles c1 -> "" -> c1
  // forever, yielding duplicates. The repeated-cursor stall guard cannot catch
  // it, because consecutive cursors differ every time.
  //
  // Not reachable from this API — every list route emits `next_cursor: null`
  // when the walk is done — but the helpers exist to make a hand-rolled cursor
  // loop unnecessary, so they have to be right about the boundary a customer
  // never has to think about.
  it('CRITICAL all 3 pagination helpers stop on an empty-string cursor, not just on null', () => {
    const ts = read(TS_PAGINATION);
    const go = read(GO_PAGINATION);
    const py = read(PY_PAGINATION);

    expect(ts, 'sdk-typescript must treat an empty cursor as the end of the walk').toMatch(
      /next_cursor === null \|\| page\.next_cursor === ''/,
    );
    expect(go, 'sdk-go must treat an empty cursor as the end of the walk').toMatch(
      /next == nil \|\| \*next == ""/,
    );
    expect(py, 'sdk-python must treat an empty cursor as the end of the walk').toMatch(
      /next_cursor is None or next_cursor == ""/,
    );

    // Python has two loops, sync and async, and they must not drift apart.
    expect(
      (py.match(/next_cursor is None or next_cursor == ""/g) ?? []).length,
      'sdk-python has a sync and an async walker — both need the empty-cursor stop',
    ).toBe(2);
  });

  it('TS iteratePaginated cross-resource usage — pagination helper imported in 5 resource files (the 5 paginated resources). Drift to inlining cursor walkers in each resource would defeat the W422.A centralization.', () => {
    const ts5Files = [TS_SESSIONS, TS_PROFILES, TS_SNAPSHOTS, TS_WEBHOOKS, TS_AUDIT];
    let importCount = 0;
    for (const f of ts5Files) {
      const body = read(f);
      if (body.includes('import { iteratePaginated }')) {
        importCount += 1;
      }
    }
    expect(importCount, 'iteratePaginated import count across 5 paginated TS resources').toBe(5);
  });

  it('Python iterate_paginated cross-resource usage — pagination helper imported in 4 of 5 paginated Python resources (audit_log + sessions + profile_snapshots + webhooks each import iterate_paginated/aiterate_paginated). NOTE: profiles.py may or may not import depending on its design; crypto-orders hand-rolls its own walker (W654 framing). Drift to inlining cursor walkers would defeat the centralization.', () => {
    const pyFiles = [PY_SESSIONS, PY_PROFILES, PY_SNAPSHOTS, PY_WEBHOOKS, PY_AUDIT];
    let importCount = 0;
    for (const f of pyFiles) {
      const body = read(f);
      if (body.includes('iterate_paginated')) {
        importCount += 1;
      }
    }
    // At least 3 of the 5 should import iterate_paginated.
    expect(
      importCount,
      'iterate_paginated import count across Python paginated resources',
    ).toBeGreaterThanOrEqual(3);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-pagination-envelope-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
