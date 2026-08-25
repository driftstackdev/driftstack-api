// W562.C — drift guard for /docs/internal/v553-unit-test-coverage-audit.md.
// V-553 AUDIT doc 2026-05-11 Wave-23. Drift here either weakens the
// 50%-file-name-match-coverage baseline, drops the HIGH-MED-LOW
// triage taxonomy, or unsets the V-553.B email.ts + cli-authorize.ts
// next-wave priority pair.
//
//   • V-553. AUDIT. Companion to V-540.A E2E coverage audit.
//   • 40 service modules / 32 unit / 60 integration / 12 E2E specs.
//   • 50% direct-name match baseline.
//   • 20 modules with no direct unit spec; HIGH-MED-LOW priority.
//   • V-553.B next-wave: email.ts + cli-authorize.ts unit specs.
//   • V-553.C profile-snapshots later.
//   • DB repo layer OUT-OF-SCOPE (Drizzle thin wrappers).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v553-unit-test-coverage-audit.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W562.C /docs/internal/v553-unit-test-coverage-audit.md content parity', () => {
  const body = read(LIB);

  it("Header + V-540.A-companion + 4-spec-count framing pinned: '# V-553 — unit-test coverage audit (services layer)' + '**Date:** 2026-05-11' + '**Wave:** 23' + '**Status:** AUDIT — gap catalogue only. Net-new unit specs land in' + 'V-553.B implementation slices.' + 'Companion to V-540.A (E2E coverage audit, Wave 19).' + '**40 service modules** in `apps/server/src/services/`.' + '**32 unit spec files** in `apps/server/tests/unit/`.' + '**60 integration specs** in `apps/server/tests/integration/`.' + '**12 E2E specs** in `apps/server/tests/e2e/` (per V-540.A audit).' + 'Service-to-unit-spec coverage at the file level is **20/40 = 50%** by' — pinned so the V-553-AUDIT-Wave-23 + V-540.A-Wave-19-E2E-companion + 40-service/32-unit/60-integration/12-E2E + 20/40=50%-direct-name-match commitment survives", () => {
    expect(body).toMatch(/^# V-553 — unit-test coverage audit \(services layer\)$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 23/);
    expect(body).toMatch(/\*\*Status:\*\* AUDIT — gap catalogue only\. Net-new unit specs land in/);
    expect(body).toMatch(/V-553\.B implementation slices\./);
    expect(body).toMatch(/Companion to V-540\.A \(E2E coverage audit, Wave 19\)\./);
    expect(body).toMatch(/- \*\*40 service modules\*\* in `apps\/server\/src\/services\/`\./);
    expect(body).toMatch(/- \*\*32 unit spec files\*\* in `apps\/server\/tests\/unit\/`\./);
    expect(body).toMatch(
      /- \*\*60 integration specs\*\* in `apps\/server\/tests\/integration\/`\./,
    );
    expect(body).toMatch(
      /- \*\*12 E2E specs\*\* in `apps\/server\/tests\/e2e\/` \(per V-540\.A audit\)\./,
    );
    expect(body).toMatch(
      /Service-to-unit-spec coverage at the file level is \*\*20\/40 = 50%\*\* by/,
    );
  });

  it("20-no-unit-spec module table + HIGH/MED/LOW priority criteria framing pinned: '## Service modules with no direct unit spec (20)' + '`auth-flows.ts`            | Yes — auth specs          | MED' + '`cli-authorize.ts`         | Partial                   | HIGH' + '`email.ts`                 | Indirect via auth-flows   | HIGH' + '`incident-broadcast.ts`    | Partial                   | MED' + '`profile-snapshots.ts`     | Partial                   | HIGH' + '## Priority criteria' + '**HIGH:** module has minimal integration coverage AND/OR the service exposes a complex algorithm where unit testing in isolation is significantly cheaper' + '**MED:** module has integration coverage but a unit spec would catch edge cases' + '**LOW:** module is thin glue; integration coverage is sufficient. Adding a unit spec is busywork.' — pinned so the 20-no-unit-spec-module + HIGH-3-module (cli-authorize + email + profile-snapshots) + MED-criteria + LOW-busywork commitment survives", () => {
    expect(body).toMatch(/## Service modules with no direct unit spec \(20\)/);
    expect(body).toMatch(/\| `auth-flows\.ts`\s+\| Yes — auth specs\s+\| MED/);
    expect(body).toMatch(/\| `cli-authorize\.ts`\s+\| Partial\s+\| HIGH/);
    expect(body).toMatch(/\| `email\.ts`\s+\| Indirect via auth-flows\s+\| HIGH/);
    expect(body).toMatch(/\| `incident-broadcast\.ts`\s+\| Partial\s+\| MED/);
    expect(body).toMatch(/\| `profile-snapshots\.ts`\s+\| Partial\s+\| HIGH/);
    expect(body).toMatch(/## Priority criteria/);
    expect(body).toMatch(
      /- \*\*HIGH:\*\* module has minimal integration coverage AND\/OR the service/,
    );
    expect(body).toMatch(/exposes a complex algorithm where unit testing in isolation is/);
    expect(body).toMatch(/significantly cheaper/);
    expect(body).toMatch(
      /- \*\*MED:\*\* module has integration coverage but a unit spec would catch/,
    );
    expect(body).toMatch(/edge cases/);
    expect(body).toMatch(
      /- \*\*LOW:\*\* module is thin glue; integration coverage is sufficient\./,
    );
    expect(body).toMatch(/Adding a unit spec is busywork\./);
  });

  it("V-553.B next-slice + DB-repo-out-of-scope + methodology framing pinned: '## Recommended next slices' + '### V-553.B (next wave)' + 'Two HIGH-priority unit specs:' + '**`email.test.ts`** — `email.ts` is a fan-out service over Postmark.' + 'Unit tests should cover template-not-found rejection, recipient' + 'suppression (opt-out list), provider-503 retry semantics.' + 'Integration tests don't exercise the retry path because Postmark mocks' + 'short-circuit it.' + '**`cli-authorize.test.ts`** — CLI authorize flow has a polling loop' + 'token-expiry semantics + race conditions between two CLI clients.' + '### V-553.C (later)' + 'Profile-snapshots service — partial integration coverage; the snapshot-' + 'diff algorithm is unit-testable in isolation.' + '### Out of scope' + 'Database repo layer (`apps/server/src/db/*-repo.ts`) — repos are thin' + 'Drizzle wrappers; coverage comes from integration tests against a real' + 'Postgres. Unit-mocking Drizzle is brittle. Skip.' + '## Coverage methodology' + 'Run `vitest --coverage` to get line-level coverage per service module.' + '## Verification' + 'V-205 + V-211 sweep: zero hits.' — pinned so the V-553.B-2-priority-spec (email.ts-Postmark-fan-out-template-not-found-503-retry + cli-authorize-polling-token-expiry-race) + V-553.C-profile-snapshots-diff + DB-repo-out-of-scope-Drizzle-brittle + vitest-coverage-line-level + V-205+V-211-zero-hits commitment survives", () => {
    expect(body).toMatch(/## Recommended next slices/);
    expect(body).toMatch(/### V-553\.B \(next wave\)/);
    expect(body).toMatch(/Two HIGH-priority unit specs:/);
    expect(body).toMatch(
      /1\. \*\*`email\.test\.ts`\*\* — `email\.ts` is a fan-out service over Postmark\./,
    );
    expect(body).toMatch(/Unit tests should cover template-not-found rejection, recipient/);
    expect(body).toMatch(/suppression \(opt-out list\), provider-503 retry semantics\./);
    expect(body).toMatch(
      /Integration\s*tests don't exercise the retry path because Postmark mocks/,
    );
    expect(body).toMatch(/short-circuit it\./);
    expect(body).toMatch(
      /2\. \*\*`cli-authorize\.test\.ts`\*\* — CLI authorize flow has a polling loop/,
    );
    expect(body).toMatch(/token-expiry semantics \+ race conditions between two CLI clients\./);
    expect(body).toMatch(/### V-553\.C \(later\)/);
    expect(body).toMatch(/Profile-snapshots service — partial integration coverage; the snapshot-/);
    expect(body).toMatch(/diff algorithm is unit-testable in isolation\./);
    expect(body).toMatch(/### Out of scope/);
    expect(body).toMatch(
      /Database repo layer \(`apps\/server\/src\/db\/\*-repo\.ts`\) — repos are thin/,
    );
    expect(body).toMatch(/Drizzle wrappers; coverage comes from integration tests against a real/);
    expect(body).toMatch(/Postgres\. Unit-mocking Drizzle is brittle\. Skip\./);
    expect(body).toMatch(/## Coverage methodology/);
    expect(body).toMatch(
      /1\. Run `vitest --coverage` to get line-level coverage per service module\./,
    );
    expect(body).toMatch(/## Verification/);
    expect(body).toMatch(/- V-205 \+ V-211 sweep: zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
