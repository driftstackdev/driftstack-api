// Cross-source invariant: secret-plaintext brand types follow a
// consistent naming convention across BYOK + gui_control_key. Each
// brand string is `<class>-plaintext` so a code reviewer can pattern-
// match dangerous casts at-a-glance. Drift on either brand name
// would orphan the compiler-enforced taint marker from the cross-
// class reading discipline.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BYOK = resolve(REPO_ROOT, 'apps/server/src/lib/byok-anthropic-encryption.ts');
const GCK = resolve(REPO_ROOT, 'apps/server/src/lib/gui-control-key-encryption.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('plaintext brand-type cross-source invariant', () => {
  const byok = read(BYOK);
  const gck = read(GCK);

  it("byok-anthropic-encryption brands as 'byok-anthropic-plaintext'", () => {
    expect(byok).toMatch(/readonly __brand: 'byok-anthropic-plaintext';/);
  });

  it("gui-control-key-encryption brands as 'gui-control-key-plaintext'", () => {
    expect(gck).toMatch(/readonly __brand: 'gui-control-key-plaintext';/);
  });

  it('Both brand types share the `-plaintext` suffix — pinned so the naming convention stays consistent (drift to a different suffix would break the at-a-glance cast-review pattern)', () => {
    const byokBrand = byok.match(/readonly __brand: '([^']+)';/);
    const gckBrand = gck.match(/readonly __brand: '([^']+)';/);
    expect(byokBrand).not.toBeNull();
    expect(gckBrand).not.toBeNull();
    expect(byokBrand![1]).toMatch(/-plaintext$/);
    expect(gckBrand![1]).toMatch(/-plaintext$/);
  });

  it("byok-anthropic JSDoc explicitly documents 'visibly unsafe in code review' rationale: 'Internal call sites must `as` an explicit cast to assign to a raw string — meant to make log/error/audit paths visibly unsafe in code review.' — pinned so the code-reviewer-catches-the-cast rationale stays documented (drift to dropping the brand would let plaintext flow into logs without TypeScript catching it)", () => {
    expect(byok).toMatch(
      /Internal call sites must `as` an explicit cast to assign to a raw\s*\*\s+`string` — meant to make log\/error\/audit paths visibly unsafe in\s*\*\s+code review\./,
    );
  });

  it("gui-control-key-encryption explicitly cross-references the BYOK taint pattern: 'Compile-time taint marker so the gui-control-key plaintext can't be assigned to a raw string without an explicit cast — matches the BYOK taint pattern.' — pinned so the matches-BYOK-pattern reference stays documented", () => {
    expect(gck).toMatch(
      /Compile-time taint marker so the gui-control-key plaintext can't\s*\*\s+be assigned to a raw `string` without an explicit cast — matches\s*\*\s+the BYOK taint pattern\./,
    );
  });
});
