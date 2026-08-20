// V-1059 — "this session is still alive" is spelled two ways, and they must agree.
//
// V-1056 found a terminal-status helper that disagreed with the rule the server
// enforces, next to two hand-built copies that had it right. Session status carries
// the same arrangement, with more copies and a worse blast radius: the answer decides
// whether a session is returned to a customer as live.
//
// Two spellings exist, and they are complements of each other over the same 5-value
// enum:
//
//   inArray(sessions.status, ACTIVE_SESSION_STATUSES)      — named, in sessions-repo
//   notInArray(sessions.status, ['destroyed', 'errored'])  — inlined, four times
//
// The asymmetry is what makes this worth pinning. Adding a NON-terminal status is one
// edit: the named constant. Adding a TERMINAL one is four, spread over two repo files,
// and every site missed keeps returning that session as live — to a list endpoint, to
// a concurrency count, to the agent-session lookup. Nothing about a missed site looks
// broken; the query still runs and still returns rows.
//
// So this derives the terminal set rather than restating it — the enum minus the named
// active constant — and requires every inlined non-terminal predicate to equal it.
// That ties the two spellings together through the schema, so the guard cannot drift
// with either side.
//
// ── V-1070: deriving alone was a false green ──────────────────────────────
//
// The first version of this file derived the site list and compared each set. That
// catches a site whose set is WRONG and cannot catch one that is GONE: deleting a
// filter outright removes it from the population instead of reporting it, and the
// arm passes. Measured — removing the `notInArray` from agent-sessions-repo, which
// makes that query hand destroyed sessions back to a customer, left all three arms
// green. The floor did not help either, since four remaining sites still cleared a
// `> 3` bound.
//
// So the population is pinned as well as derived. EXPECTED_SITES records how many
// of these filters each file carries; a deletion drops the count and an addition
// raises it, and either way someone has to come here and say which. This is the
// same correction V-1069 made to itself, applied to the guard that had shipped with
// the flaw already in it.
//
// ── The one site that is deliberately different ────────────────────────────
//
// sessions-repo.ts also has `notInArray(status, ['busy', 'destroyed', 'errored'])`,
// which is not the non-terminal predicate at all — it additionally refuses `busy`. It
// is listed below with that reason rather than silently tolerated, because a scan
// that quietly accepted any superset would also accept a site that had drifted.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { SessionStatusSchema } from '@driftstack/api-types';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');
const SESSIONS_REPO = resolve(SRC, 'db/sessions-repo.ts');

/**
 * Predicates over `sessions.status` that are NOT the plain non-terminal test, with
 * the reason each is acceptable.
 *
 * `busy,destroyed,errored` — sessions-repo's single-session claim path. It refuses a
 * session that is already busy in addition to the terminal two, so that a second
 * claimant cannot take a session mid-use. Deliberately stricter than non-terminal.
 */
const NOT_THE_NON_TERMINAL_TEST: ReadonlySet<string> = new Set(['busy,destroyed,errored']);

/**
 * How many `notInArray(<x>.status, [...])` filters each file carries.
 *
 * Pinned because the derived arms below can only judge a filter they can see. A
 * query that drops its filter stops being visible and starts returning terminal
 * sessions, which is the more damaging of the two failures.
 */
const EXPECTED_SITES: Readonly<Record<string, number>> = {
  'db/agent-sessions-repo.ts': 1,
  'db/sessions-repo.ts': 4,
};

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

/** The named active constant, read from the repo that declares it. */
function activeStatuses(): string[] {
  const src = readFileSync(SESSIONS_REPO, 'utf8');
  const m = /const ACTIVE_SESSION_STATUSES[^=]*=\s*\[([^\]]*)\]/.exec(src);
  expect(m, 'ACTIVE_SESSION_STATUSES is no longer declared in db/sessions-repo.ts').not.toBeNull();
  return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** Terminal = every declared status that is not named active. Derived, not restated. */
function terminalStatuses(): string[] {
  const active = new Set(activeStatuses());
  return SessionStatusSchema.options.filter((s) => !active.has(s)).sort();
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly key: string;
}

/** Every `notInArray(<something>.status, [...])` over session-status literals. */
function notInArraySites(): Site[] {
  const declared = new Set<string>(SessionStatusSchema.options);
  const out: Site[] = [];
  for (const f of serverFiles()) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/notInArray\(\s*\w+\.status\s*,\s*\[([^\]]*)\]/g)) {
      const vals = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
      if (vals.length === 0 || !vals.every((v) => declared.has(v))) continue;
      out.push({
        file: f.slice(REPO_ROOT.length + 1),
        line: src.slice(0, m.index).split('\n').length,
        key: [...vals].sort().join(','),
      });
    }
  }
  return out;
}

describe('V-1059 every non-terminal session query agrees', () => {
  it('CRITICAL the two spellings partition the enum, and the scan finds the call sites. If the active constant went missing, or the scan matched nothing, every arm below would agree with a server whose queries say anything at all.', () => {
    const active = activeStatuses();
    const terminal = terminalStatuses();

    expect(SessionStatusSchema.options.length, 'declared session statuses').toBe(5);
    expect(active.length, 'ACTIVE_SESSION_STATUSES members').toBeGreaterThanOrEqual(3);
    expect(terminal.length, 'terminal statuses derived').toBeGreaterThanOrEqual(2);

    // Complements: nothing in both, nothing in neither.
    expect(
      [...active, ...terminal].sort(),
      'active and terminal do not partition SessionStatusSchema — a status in both, or in ' +
        'neither, means some query treats it as live and another does not',
    ).toEqual([...SessionStatusSchema.options].sort());

    expect(notInArraySites().length, 'notInArray(status, [...]) call sites found').toBeGreaterThan(
      3,
    );
  });

  it('CRITICAL every inlined non-terminal predicate equals the derived terminal set. Adding a terminal status is a four-site edit across two repo files, and a site left behind keeps handing that session to a customer as live — from a list endpoint, a concurrency count, or the agent-session lookup. The query still runs, so nothing looks broken.', () => {
    const expected = terminalStatuses().join(',');
    const wrong = notInArraySites()
      .filter((s) => s.key !== expected && !NOT_THE_NON_TERMINAL_TEST.has(s.key))
      .map((s) => `${s.file}:${String(s.line)} excludes [${s.key}], expected [${expected}]`)
      .sort();
    expect(
      wrong,
      'these session-status predicates disagree with the terminal set derived from the schema — ' +
        'update them together, or list the ones that are deliberately stricter with the reason:',
    ).toEqual([]);
  });

  it('CRITICAL the deliberately-stricter list holds no stale entry. A predicate that has since been brought back in line would sit here pre-approving whatever next appears at that shape.', () => {
    const live = new Set(notInArraySites().map((s) => s.key));
    expect(
      [...NOT_THE_NON_TERMINAL_TEST].filter((k) => !live.has(k)).sort(),
      'listed as deliberately different from the non-terminal test, but no query spells it that ' +
        'way any more — drop the entry:',
    ).toEqual([]);
  });

  it('CRITICAL no file has quietly lost a non-terminal filter. Deleting one removes it from every derived arm above rather than failing them — measured, and it left this file green while an agent-session query returned destroyed sessions. The count is what makes a deletion visible.', () => {
    const perFile = new Map<string, number>();
    for (const site of notInArraySites()) {
      const key = site.file.replace('apps/server/src/', '');
      perFile.set(key, (perFile.get(key) ?? 0) + 1);
    }
    const drifted: string[] = [];
    for (const [file, expected] of Object.entries(EXPECTED_SITES)) {
      const actual = perFile.get(file) ?? 0;
      if (actual !== expected) drifted.push(`${file}: expected ${expected}, found ${actual}`);
    }
    for (const [file, actual] of perFile) {
      if (!(file in EXPECTED_SITES)) drifted.push(`${file}: ${actual} unregistered filter(s)`);
    }
    expect(
      drifted.sort(),
      'the session-status filter population changed — a removed filter means that query now returns ' +
        'terminal sessions; a new one belongs in EXPECTED_SITES:',
    ).toEqual([]);
  });
});
