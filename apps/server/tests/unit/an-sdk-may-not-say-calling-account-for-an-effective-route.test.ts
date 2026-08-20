// V-1124 — one claim produced five findings, so it gets a guard instead of a sixth.
//
// V-1101, V-1103, V-1121, V-1122 and V-1123 were all the same sentence: a doc or an
// SDK saying a surface is scoped to the CALLING account where the route resolves an
// EFFECTIVE one. Under `X-Driftstack-Account` a team admin acts as the owner, so the
// difference is whose data comes back — and the wrong version reads as a reassurance
// rather than an error, which is why it survived three sweeps looking for it.
//
// Fixing the sentence five times did not stop the sixth. This derives the pairing
// instead.
//
// ── What is derived, and what is not ────────────────────────────────────────
//
// TypeScript SDK resources are named after their route module — `webhooks.ts` for
// `routes/webhooks.ts`, `profiles.ts` for `routes/profiles.ts`. Twelve of the
// nineteen pair that way, and for those the map needs no maintenance: the guard reads
// the route, decides whether its list handler resolves an effective account, and
// requires the docstrings to match.
//
// Seven do NOT pair, because their routes live under a different name — `account`,
// `api-keys`, `audit-log`, `crypto-orders`, `egress`, `mfa`, `usage`. A hand-written
// map for those would be the roster-is-its-own-population shape this suite has spent
// V-1106 through V-1113 removing, so they are OUT OF SCOPE and said to be, rather
// than covered by a list someone has to remember. `audit-log` in particular IS
// effective-scoped and was corrected by hand in V-1123; this guard cannot see it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SURFACES: ReadonlyArray<{ label: string; dir: string; ext: string }> = [
  { label: 'ts', dir: 'packages/sdk-typescript/src/resources', ext: '.ts' },
  { label: 'py', dir: 'packages/sdk-python/src/driftstack/resources', ext: '.py' },
  { label: 'go', dir: 'packages/sdk-go', ext: '.go' },
  { label: 'doc', dir: 'apps/docs/src/pages/api', ext: '.md' },
];
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

/**
 * Lines that name the calling account CORRECTLY, on a module whose routes are
 * mixed, with the reason each is right.
 *
 * `billing` is the only module in the paired set where some routes resolve an
 * effective account and others do not, so a file-wide detector cannot judge its
 * prose line by line — and per-handler attribution is what V-1123 got wrong three
 * times running. Both entries were checked against the route:
 *
 *   `doc:billing` — the page states the split exactly: all `/v1/billing/*` are
 *   caller-scoped "with one read exception: `GET /v1/billing` honors the
 *   team-RBAC `X-Driftstack-Account` header". That handler really does resolve an
 *   effective account (`billing.ts:178`), and the mutation endpoints really do not.
 *
 *   `py:billing` — `portal_session()` documents `POST /v1/billing/portal-session`,
 *   which is caller-only. Naming the calling account there is correct.
 */
const CORRECT_AS_WRITTEN: ReadonlyArray<{ prefix: string; needle: string }> = [
  { prefix: 'doc:billing', needle: 'with one read exception' },
  { prefix: 'py:billing', needle: 'Stripe Customer Portal session' },
];

/** SDK resources whose route module carries a different filename. */
const UNPAIRED = ['account', 'api-keys', 'audit-log', 'crypto-orders', 'egress', 'mfa', 'usage'];

/** Every (surface, resource) pair whose name matches a route module. */
function pairedFiles(): { label: string; resource: string; path: string }[] {
  const out: { label: string; resource: string; path: string }[] = [];
  for (const s of SURFACES) {
    const dir = resolve(REPO_ROOT, s.dir);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(s.ext) && !n.includes('_test'))) {
      // Python uses snake_case filenames for hyphenated route modules.
      const resource = f.slice(0, -s.ext.length).replace(/_/g, '-');
      if (existsSync(resolve(ROUTES, `${resource}.ts`))) {
        out.push({ label: s.label, resource, path: resolve(dir, f) });
      }
    }
  }
  return out;
}

/**
 * Whether the route module resolves an effective account anywhere.
 *
 * Deliberately file-wide rather than per-handler. V-1123 spent three attempts on a
 * per-handler window and got a different answer each time — too narrow missed the
 * resolution, too wide caught the next handler, and keying on an `effectiveAccountId:`
 * option missed the two modules that pass `effective.accountId` positionally. A module
 * that resolves an effective account ANYWHERE is one whose docstrings must not promise
 * caller-only scoping, which is the property this guard actually needs.
 */
function resolvesEffective(resource: string): boolean {
  const src = readFileSync(resolve(ROUTES, `${resource}.ts`), 'utf8').replace(/\/\/[^\n]*/g, '');
  return /effectiveAccountIdFor|resolveEffectiveAccount|effective\.accountId|eff\.accountId/.test(
    src,
  );
}

/** Lines on a paired surface that promise calling-account scoping. */
function callingAccountLines(file: { label: string; resource: string; path: string }): string[] {
  const src = readFileSync(file.path, 'utf8');
  // Which lines count as prose a reader sees.
  //
  // Markdown has no comment syntax, so every line counts. Python needed a state
  // machine rather than a per-line test: V-1125 measured it, and a filter keyed on
  // a leading marker sees only the FIRST line of a docstring — the phrase this was
  // built to catch sat on a CONTINUATION line, so the guard stayed green while the
  // defect was reintroduced under it.
  const lines = src.split('\n');
  const prose = new Set<number>();
  let inDoc = false;
  lines.forEach((l, i) => {
    if (file.label === 'doc') {
      prose.add(i);
      return;
    }
    if (file.label === 'py') {
      const fences = (l.match(/"""/g) ?? []).length;
      if (inDoc || fences > 0 || /^\s*#/.test(l)) prose.add(i);
      if (fences % 2 === 1) inDoc = !inDoc;
      return;
    }
    // ts / go — block and line comments, continuation lines included.
    if (/^\s*(\/\*\*|\*|\/\/)/.test(l)) prose.add(i);
  });
  return (
    lines
      .map((l, i) => [l, i + 1] as const)
      .filter(([, n]) => prose.has(n - 1))
      // Six spellings so far, each found only after the previous fix shipped: "the
      // calling account", "calling account's", "the caller's account", "your account
      // owns", "owned by the calling account", and — V-1126 — "the current account",
      // which the Go and Python SDKs preferred and which no pattern built from the
      // first five could match.
      //
      // NOT included: "the account's X". That names no particular account, so it is
      // vague rather than wrong — the judgement the plan applied to the ambiguous
      // recipes docstrings applies here too.
      .filter(([l]) =>
        /\bthe calling account\b|\bcalling account's\b|\bthe caller's account\b|\bthe current account\b|\bcurrent account's\b/.test(
          l,
        ),
      )
      // "With no header, the calling account remains the owner" is the one sentence
      // where naming the caller is exactly right.
      .filter(([l]) => !/With no header/.test(l))
      // A retraction has to be able to name what it retracts.
      .filter(([l]) => !/V-\d{3,4}/.test(l))
      .map(([l, n]) => `${file.label}:${file.resource}:${String(n)} ${l.trim().slice(0, 64)}`)
  );
}

describe('V-1124 an SDK may not say calling account for an effective-scoped route', () => {
  it('CRITICAL the pairing really resolved, and both detectors discriminate. The comparison below reports an ABSENCE, so a pairing that matched nothing would report every SDK clean having read none of them.', () => {
    const paired = pairedFiles();
    expect(
      paired.length,
      'surface files paired to a same-named route module',
    ).toBeGreaterThanOrEqual(40);
    expect(
      new Set(paired.map((p) => p.label)).size,
      'all four surfaces contribute pairs — ts, py, go and the customer docs',
    ).toBe(4);

    // The effective-account detector must separate the two known cases.
    expect(resolvesEffective('webhooks'), 'webhooks resolves an effective account').toBe(true);
    expect(resolvesEffective('legal'), 'legal is caller-scoped').toBe(false);
  });

  it('CRITICAL no SDK resource promises calling-account scoping for a route that resolves an effective account. Under X-Driftstack-Account a team admin acts as the owner, so this sentence tells a customer the wrong data comes back — and it reads as a reassurance, which is how it survived being corrected five times.', () => {
    const offenders = pairedFiles()
      .filter((f) => resolvesEffective(f.resource))
      .flatMap((f) => callingAccountLines(f))
      .filter(
        (l) => !CORRECT_AS_WRITTEN.some((e) => l.startsWith(e.prefix) && l.includes(e.needle)),
      )
      .sort();
    expect(
      offenders,
      'these SDK doc comments promise the calling account on a route that resolves an effective ' +
        'one — say EFFECTIVE, or explain which surface really is caller-only:',
    ).toEqual([]);
  });

  it('CRITICAL the unpaired list names resources this guard cannot reach, and every one is really unpaired. An entry that has since gained a same-named route module would silently drop out of the check above while still looking excused.', () => {
    const stillUnpaired = UNPAIRED.filter((n) => !existsSync(resolve(ROUTES, `${n}.ts`)));
    expect(
      UNPAIRED.filter((n) => existsSync(resolve(ROUTES, `${n}.ts`))),
      'these are listed as unpaired but a same-named route module now exists — drop them from ' +
        'UNPAIRED so the derived check covers them:',
    ).toEqual([]);
    expect(stillUnpaired.length, 'resources genuinely outside the pairing').toBe(UNPAIRED.length);
  });
  it('CRITICAL the correct-as-written list holds no stale entry. An exemption for a line that has since been reworded excuses nothing while quietly narrowing the check — and these two are the only reason a mixed-scoping module can be in the paired set at all.', () => {
    const all = pairedFiles()
      .filter((f) => resolvesEffective(f.resource))
      .flatMap((f) => callingAccountLines(f));
    const stale = CORRECT_AS_WRITTEN.filter(
      (e) => !all.some((l) => l.startsWith(e.prefix) && l.includes(e.needle)),
    ).map((e) => `${e.prefix} :: ${e.needle}`);
    expect(
      stale.sort(),
      'listed as correct-as-written but no such line exists any more — drop the entry:',
    ).toEqual([]);
  });
});
