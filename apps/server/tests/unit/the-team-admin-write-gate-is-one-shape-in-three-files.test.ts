// `effectiveAccountIdForWrite` is copied into three route files, and 21 write
// endpoints depend on it to refuse a non-admin acting on a team owner.
//
// The copies are NOT identical text and should not be: each carries a
// domain-specific refusal message ("Profile writes…", "Webhook writes…",
// "Snapshot writes…") and profile-snapshots names its local `eff` where the
// others use `effective`. A hash comparison flags all three as divergent, which
// is how this file came to exist — the divergence was entirely cosmetic.
//
// ⛔ What must NOT diverge is the SHAPE: resolve the effective account, return
// undefined when the request is not team-scoped, and throw when the role is not
// admin. A copy that gained a condition, lost the throw, or returned the account
// id before checking the role would be a silent authz hole in whichever domain
// owns it — one line, in one of three files, with nothing else to notice.
//
// So this compares the copies with identifiers and string literals normalised
// away, which is the only comparison that is about behaviour rather than prose.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(HERE, '..', '..', '..', '..', 'apps/server/src/routes');
const FILES = ['profiles.ts', 'webhooks.ts', 'profile-snapshots.ts'] as const;

/** The function body, with local names and message text normalised out. */
function shapeOf(file: string): string {
  const src = readFileSync(resolve(ROUTES, file), 'utf8');
  const m = /function effectiveAccountIdForWrite[\s\S]*?\n\}/.exec(src);
  if (m === null) return `<no effectiveAccountIdForWrite in ${file}>`;
  return m[0]
    .replace(/'[^']*'/g, "'S'") // refusal messages are per-domain by design
    .replace(/\beff(ective)?\b/g, 'E') // the local is named `eff` in one file
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the team-admin write gate is one shape in three files', () => {
  it('CRITICAL all three files still define the gate. If a copy is renamed or removed, the comparison below silently compares two things — or none — and passes.', () => {
    for (const f of FILES) {
      expect(shapeOf(f), `${f} no longer defines effectiveAccountIdForWrite`).toMatch(
        /^function effectiveAccountIdForWrite/,
      );
    }
  });

  it('CRITICAL the three copies are the SAME SHAPE once per-domain messages and local names are normalised. A copy that gained a condition, lost the throw, or returned the account id before checking the role is a silent authz hole in one domain only — one line, in one of three files.', () => {
    const [a, b, c] = FILES.map(shapeOf);
    expect(b, 'webhooks diverges from profiles').toBe(a);
    expect(c, 'profile-snapshots diverges from profiles').toBe(a);
  });

  it('CRITICAL the shape still contains the refusal, so the arm above cannot pass on three copies that all lost it together.', () => {
    expect(shapeOf('profiles.ts')).toMatch(/if \(E\.role !== 'S'\) \{ throw new ForbiddenError/);
    expect(shapeOf('profiles.ts')).toMatch(/if \(E\.kind !== 'S'\) return undefined;/);
  });
});
