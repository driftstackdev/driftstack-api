// V-837 — the team-role rule, computed from the routes instead of described in
// prose, because the prose was wrong twice.
//
// `docs/architecture/team-roles-taxonomy.md` and `docs/decisions.md` both state
// how team membership gates `/v1/*`. Both have now been wrong:
//
//   V-822 found them claiming team roles gate the dashboard ONLY, while thirteen
//   route modules gate the API on them. That correction is in place.
//
//   V-831 found MY correction wrong in turn. I wrote "reads are role-agnostic",
//   having checked one module — `account-audit.ts`, which does not check role —
//   and generalised to thirteen. `GET /v1/agent-sessions` requires `admin`,
//   deliberately: agent sessions carry transcripts and live control state, so
//   collection reads were never widened to read-only members. The one read that
//   is not role-agnostic is the most sensitive one.
//
// Both times a content-parity pin froze the sentence and the suite stayed green
// over it, because a text pin asserts what its author wrote. V-833 is the
// general form: only a guard that recomputes can contradict its own author.
// This is that guard for this claim.
//
// It does not pin the wording. It derives the split — which role checks sit on
// write paths, which sit on reads — and fails when the answer changes, so the
// next person to widen or narrow a gate has to come and say so here and in the
// two documents.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const TAXONOMY = resolve(REPO_ROOT, 'docs/architecture/team-roles-taxonomy.md');
const SCHEMA = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');

/**
 * Helpers whose whole job is to gate a WRITE on the admin role, plus the
 * access predicate. A role check inside one of these is a write gate wherever
 * it is called from; a role check in a handler is judged by that handler's verb.
 */
const ROLE_GATING_HELPERS: readonly string[] = [
  'effectiveAccountIdForWrite',
  'effectiveAccountIdForKeyWrite',
  'effectiveAccountIdForLiveOperation',
  'callerCanAccessAgentSession',
];

/**
 * READ routes that require `admin` anyway, with the reason. Empty would mean
 * "reads are role-agnostic" is true without qualification; it is not, and the
 * documents must carry the exception for as long as this list is non-empty.
 */
const ADMIN_ONLY_READS: readonly string[] = ['/v1/agent-sessions'];

interface Check {
  readonly file: string;
  readonly kind: 'HELPER' | 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  readonly where: string;
}

/** Every `role === 'admin'` / `role !== 'admin'` check, attributed to its enclosing handler or helper. */
function roleChecks(): Check[] {
  const out: Check[] = [];
  for (const name of readdirSync(ROUTES)) {
    if (!name.endsWith('.ts')) continue;
    const raw = readFileSync(join(ROUTES, name), 'utf8');
    if (!/resolveEffectiveAccount|effectiveAccountIdForWrite|callerCanAccessAgentSession/.test(raw))
      continue;
    // Comments are stripped first: a retraction naming a role check would
    // otherwise be counted as one. That mistake has been made three times in
    // this sweep with other extractors.
    const src = raw.replace(/\/\/[^\n]*/g, '');

    const regs = [
      ...src.matchAll(/app\.(get|post|patch|delete|put)[^\n]*\n?\s*'(\/v1\/[^']*)'/g),
    ].map((m) => ({
      at: m.index ?? 0,
      verb: (m[1] as string).toUpperCase() as Check['kind'],
      path: m[2] as string,
    }));
    const fns = [...src.matchAll(/function (\w+)/g)].map((m) => ({
      at: m.index ?? 0,
      name: m[1] as string,
    }));

    for (const m of src.matchAll(/role !== 'admin'|role === 'admin'/g)) {
      const at = m.index ?? 0;
      const reg = regs.filter((r) => r.at < at).pop();
      const fn = fns.filter((f) => f.at < at).pop();
      if (fn && (!reg || fn.at > reg.at)) out.push({ file: name, kind: 'HELPER', where: fn.name });
      else if (reg) out.push({ file: name, kind: reg.verb, where: reg.path });
    }
  }
  return out;
}

describe('V-837 the team-role read/write split is derived, not described', () => {
  it('CRITICAL the scan really attributes role checks to handlers. Every arm below partitions this list, so an empty parse would satisfy all of them and report a rule that was computed over nothing — the failure mode this sweep kept finding in other guards.', () => {
    const checks = roleChecks();
    expect(checks.length, 'team-role checks found across the route modules').toBeGreaterThan(8);
    expect(
      new Set(checks.map((c) => c.file)).size,
      'route modules carrying at least one',
    ).toBeGreaterThan(4);
  });

  it('CRITICAL every role check is a write gate, except the reads recorded as admin-only. This is the claim V-822 and V-831 both got wrong in prose. A role check appearing in a new GET means reads have narrowed and both documents now overstate what a member can read; a check leaving this list means they understate it.', () => {
    const adminReads = roleChecks()
      .filter((c) => c.kind === 'GET')
      .map((c) => c.where)
      .sort();

    expect(
      adminReads,
      'GET routes gated on the admin role. If this changed, update docs/architecture/team-roles-taxonomy.md and docs/decisions.md in the same commit — both state the read rule in prose:',
    ).toEqual([...ADMIN_ONLY_READS].sort());
  });

  it('CRITICAL every role check outside a handler sits in a known write-gating helper. Without this the arm above could be satisfied by moving a read gate into a helper, where it would stop looking like a GET and stop being counted — the check would go quiet rather than fail.', () => {
    const unknown = roleChecks()
      .filter((c) => c.kind === 'HELPER')
      .map((c) => c.where)
      .filter((h) => !ROLE_GATING_HELPERS.includes(h))
      .sort();

    expect(unknown, 'role check in a helper this guard does not know about:').toEqual([]);
  });

  it('CRITICAL the taxonomy doc still carries the exception while one exists. The failure V-831 corrected was a document stating the rule without it; if ADMIN_ONLY_READS is ever emptied, this arm and that paragraph should go together.', () => {
    expect(ADMIN_ONLY_READS.length, 'admin-only reads recorded').toBeGreaterThan(0);
    const doc = readFileSync(TAXONOMY, 'utf8');
    expect(doc).toMatch(/\*\*Reads are role-agnostic with one exception\*\*/);
    expect(doc, 'the exception must name the route').toMatch(/`GET \/v1\/agent-sessions`/);
  });

  it("V-851 CRITICAL the taxonomy doc's shipped-roles note matches the enum it describes. Two pre-existing pins already fail if `viewer` is added to team_role, so the DECISION cannot change silently — but nothing tied those to the prose. Building viewer would fire the enum pins, someone would update them, and the doc would go on saying two of four ship. That is the fix-one-copy shape this arc has now hit five times, and this is the tie that closes it here.", () => {
    const schema = readFileSync(SCHEMA, 'utf8').replace(/\/\/[^\n]*/g, '');
    const m = /teamRole = pgEnum\('team_role', \[([^\]]*)\]\)/.exec(schema);
    expect(m, 'the team_role enum declaration').not.toBeNull();
    const shipped = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort();
    expect(shipped, 'roles the enum actually carries').toEqual(['admin', 'member']);

    const doc = readFileSync(TAXONOMY, 'utf8');
    expect(
      doc,
      'the note must state how many of the designed roles ship, and stay true to the enum above',
    ).toMatch(/\*\*V-822 — two of these four ship\.\*\*/);
    expect(doc, 'and must quote the enum it is describing').toMatch(
      /`pgEnum\('team_role', \['member', 'admin'\]\)`/,
    );
  });
});
