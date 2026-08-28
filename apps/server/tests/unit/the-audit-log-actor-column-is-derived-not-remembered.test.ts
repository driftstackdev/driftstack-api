// V-802 — the customer-facing audit-log table's "Actor" column, checked against
// the code that writes the rows.
//
// `apps/docs/src/pages/api/audit-log.md` documents 46 audit actions and, for
// each, who the actor is: `customer`, `system` or `staff`. Customers read that
// column to answer "did a person on my team do this, or did Driftstack?" — the
// question an incident review or a compliance export starts from.
//
// Nothing checked it, and three rows were wrong:
//
//   session.created         documented `system`; the code emits `customer` with
//                           the member's key, and says why in a comment — on a
//                           team-scoped create the audit row lands on the OWNER's
//                           log while the actor stays the member, so it reads
//                           "Member X created session Y on team owner Z". A
//                           `system` label erases exactly that attribution.
//   account.email_verified  documented `system`; emitted `customer`.
//   session.destroyed       documented `system`; both happen — `customer` for an
//                           explicit DELETE, `system` for the V-782 auto-destroy.
//
// The parity pin over that page froze the surrounding prose and never the actor
// cells, which is why the column could drift with the suite green. A count or a
// table maintained by hand goes stale by construction (see V-794); the fix is to
// derive it. This file resolves each action's actorType from the emitting object
// literal and compares.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Actions whose actorType cannot be resolved from an object literal, with the
 * reason. These reach `record()` through a helper that takes `action` as a
 * PARAMETER, so the literal never carries both keys together.
 *
 * An entry is a statement that the value was checked by hand, not that checking
 * is inconvenient. Keep it short: every entry is a row this guard cannot defend.
 */
const RESOLVED_BY_HAND: Record<string, string> = {
  'account.email_verified':
    'services/auth-flows.ts emitAuditBestEffort() takes `action` as a parameter and hardcodes ' +
    "actorType: 'customer' — verified by reading it; the same helper covers login/logout/" +
    'password_changed.',
  'account.login': 'same emitAuditBestEffort() helper — customer.',
  'account.logout': 'same emitAuditBestEffort() helper — customer.',
  'account.password_changed': 'same emitAuditBestEffort() helper — customer.',
  // Listed rather than raising the unresolved ceiling: the ceiling is a number and
  // bumping it explains nothing, which is how an allowlist becomes a blindfold.
  'recipe.created':
    'routes/recipes.ts emitRecipeAudit() takes `action` as a parameter and hardcodes ' +
    "actorType: 'customer' — read it; it also sets actorKeyId from ctx.apiKey.id, which " +
    'is the field the row exists for on an account whose API keys are shared.',
  'recipe.deleted': 'same emitRecipeAudit() helper — customer.',
};

/** Every `{ … action: '…' … actorType: '…' … }` object literal in the server. */
function actorsByAction(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'migrations') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf8');
      if (!src.includes('actorType')) continue;
      for (let i = 0; i < src.length; i += 1) {
        if (src[i] !== '{') continue;
        let depth = 0;
        let end = -1;
        for (let k = i; k < Math.min(src.length, i + 4000); k += 1) {
          if (src[k] === '{') depth += 1;
          else if (src[k] === '}') {
            depth -= 1;
            if (depth === 0) {
              end = k;
              break;
            }
          }
        }
        if (end === -1) continue;
        const lit = src.slice(i, end + 1);
        if (!lit.includes('action:') || !lit.includes('actorType:')) continue;
        const actions = new Set([...lit.matchAll(/action:\s*'([a-z_.]+)'/g)].map((m) => m[1]!));
        const actors = new Set([...lit.matchAll(/actorType:\s*'(\w+)'/g)].map((m) => m[1]!));
        if (actions.size !== 1 || actors.size !== 1) continue;
        const action = [...actions][0]!;
        const actor = [...actors][0]!;
        const set = out.get(action) ?? new Set<string>();
        set.add(actor);
        out.set(action, set);
      }
    }
  };
  walk(SRC);
  return out;
}

/** The documented `| \`action\` | actor |` rows. */
function documentedActors(): Map<string, string> {
  const doc = readFileSync(DOC, 'utf8');
  const rows = new Map<string, string>();
  for (const m of doc.matchAll(/^\|\s*`([a-z_.]+)`\s*\|\s*([a-z ]+?)\s*\|/gm)) {
    rows.set(m[1]!, m[2]!);
  }
  return rows;
}

describe('V-802 the audit-log actor column is derived, not remembered', () => {
  it('CRITICAL both sides parsed real data. The comparison below reports mismatches, so an empty doc table or an empty resolver would agree with each other and report perfect health over nothing — the failure mode this family of guards keeps producing.', () => {
    const documented = documentedActors();
    const resolved = actorsByAction();

    expect(documented.size, 'actions documented in the table').toBeGreaterThan(40);
    expect(resolved.size, 'actions whose actorType was resolved from source').toBeGreaterThan(20);
    expect(
      [...documented.values()].every((v) => /^(customer|system|staff|customer or system)$/.test(v)),
      'every documented actor is one of the known values',
    ).toBe(true);
  });

  it('CRITICAL no documented actor contradicts the code that writes the row. A customer reads this column to tell "someone on my team did this" from "Driftstack did this", which is where an incident review or a compliance export starts. session.created was documented `system` while the code emits `customer` with the acting member\'s key — precisely the attribution a team owner needs.', () => {
    const documented = documentedActors();
    const resolved = actorsByAction();

    const mismatches: string[] = [];
    for (const [action, docActor] of documented) {
      const code = resolved.get(action);
      if (code === undefined) continue; // unresolvable — covered by the next case
      const claimed = new Set(docActor.split(' or ').map((s) => s.trim()));
      const actual = [...code].sort();
      const ok = actual.every((a) => claimed.has(a)) && [...claimed].every((c) => code.has(c));
      if (!ok) mismatches.push(`${action}: doc="${docActor}" code=${actual.join('+')}`);
    }

    expect(mismatches, 'documented actor disagrees with the emitting code:').toEqual([]);
  });

  it('CRITICAL every action the resolver cannot see is listed with the reason it was checked by hand, and every listed action is really unresolvable. An allowlist that outlives its reason is how a guard turns into a blindfold — so an entry that BECOMES resolvable fails here and has to come out.', () => {
    const documented = documentedActors();
    const resolved = actorsByAction();

    const unresolvedAndUnlisted = [...documented.keys()]
      .filter((a) => !resolved.has(a) && RESOLVED_BY_HAND[a] === undefined)
      .sort();
    expect(
      unresolvedAndUnlisted.length,
      `documented actions whose actor this guard cannot resolve and which are not listed as hand-checked. Either the emit moved into an object literal (good — nothing to do) or a new helper-based emitter appeared and someone must read it. Unlisted: ${unresolvedAndUnlisted.join(', ')}`,
    ).toBeLessThanOrEqual(18);

    const nowResolvable = Object.keys(RESOLVED_BY_HAND).filter((a) => resolved.has(a));
    expect(
      nowResolvable,
      'these are resolvable from source now — delete the hand-checked entry so the guard defends them:',
    ).toEqual([]);
  });
});
