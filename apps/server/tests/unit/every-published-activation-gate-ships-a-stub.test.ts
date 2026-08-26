// A published operation behind an activation gate answers 503 when the feature is
// off, or it is listed here as a known gap.
//
// Three guards already assert this invariant and none of them can enforce it.
// `every-activation-gate-has-a-refusing-disabled-variant` derives its population by
// scanning `app.ts` for `register…DisabledRoutes` CALLS;
// `activation-gate-disabled-stub-registrar-roster…` discovers `register…DisabledRoutes`
// EXPORTS in `routes/`; `activation-gate-pattern-cross-source-invariant` walks a hand
// roster of features that already have both halves. All three census the STUB side, so
// a gate that never had a stub emits nothing for any of them to find. V-1756 found
// three such gates by hand — `mfaService`, `cliAuthorizeService`, `cryptoOrdersService`
// — and every one had been invisible to all three since the day it was written.
//
// ⛔ The gate side is NOT simply the missing half, and a naive version of this file is
// worse than none. Enumerating `if (deps.X !== undefined)` blocks that register routes
// and lack a stub reports SEVENTEEN, against a real count of three. The other fourteen
// are gates whose dep `bootstrap.ts` wires unconditionally, so the `else` can never be
// taken and a stub would be dead code. Whether a dep can be ABSENT is not visible in
// `app.ts` at all, which is a real reason the other three guards stayed on the stub
// side rather than an oversight.
//
// So the population is a four-term join, and each term removes a class of false
// positive that was measured, not imagined:
//
//   1. the gate's block registers routes          (else it gates a service, not a surface)
//   2. the block has no `register…DisabledRoutes` (else it already complies)
//   3. `bootstrap.ts` wires the dep CONDITIONALLY (else the `else` is unreachable)
//   4. the routes it registers are PUBLISHED      (else no contract promises them)
//
// Term 4 is what separates `cryptoOrdersService` (18 routes, 18 published) from
// `nowpaymentsIpnSecret` (1 route, 0 published). The latter is inbound webhook ingress:
// a 404 tells the sender to stop retrying, while a 503 would have it retry forever
// against a deployment that will never accept the callback. Applying the pattern there
// would be actively worse, which is why term 4 is a correctness requirement and not a
// convenience.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const APP = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

/**
 * Gates whose published surface 404s today, each with why it is not yet fixed.
 *
 * An entry here is a debt, not a licence: the arm below fails when a listed gate
 * gains its stub, so closing one forces the line to be deleted rather than left
 * to rot into a permanent exemption.
 */
const KNOWN_GAPS: ReadonlyMap<string, string> = new Map([]);

interface Gate {
  dep: string;
  registrars: string[];
  hasStub: boolean;
  conditionallyWired: boolean;
  publishedPaths: string[];
}

function gates(): Gate[] {
  const app = readFileSync(APP, 'utf8').split('\n');
  const boot = readFileSync(BOOTSTRAP, 'utf8');
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as { paths: Record<string, unknown> };
  const published = new Set(Object.keys(spec.paths));

  const routeSource = new Map<string, string>();
  for (const f of readdirSync(ROUTES_DIR)) {
    if (f.endsWith('.ts')) routeSource.set(f, readFileSync(resolve(ROUTES_DIR, f), 'utf8'));
  }
  const pathsOf = (registrar: string): string[] => {
    for (const src of routeSource.values()) {
      if (new RegExp(`export function ${registrar}\\b`).test(src)) {
        return [...src.matchAll(/'(\/v1\/[^']+)'/g)].map((m) => m[1] ?? '');
      }
    }
    return [];
  };

  const out: Gate[] = [];
  app.forEach((line, i) => {
    const m = /^\s*if \(deps\.([a-zA-Z]+) !== undefined/.exec(line);
    if (!m) return;
    const dep = m[1] ?? '';
    let depth = 0;
    let end = i;
    for (let j = i; j < Math.min(i + 260, app.length); j += 1) {
      depth += (app[j]?.match(/\{/g) ?? []).length - (app[j]?.match(/\}/g) ?? []).length;
      if (j > i && depth <= 0) {
        end = j;
        break;
      }
    }
    const block = app.slice(i, end + 1).join('\n');
    const tail = app.slice(end, end + 4).join('\n');
    const registrars = [...block.matchAll(/\b(register\w*Routes)\(/g)]
      .map((r) => r[1] ?? '')
      .filter((r) => !r.endsWith('DisabledRoutes'));
    if (registrars.length === 0) return;

    const paths = registrars.flatMap(pathsOf);
    const templated = paths.map((p) => p.replace(/:([a-zA-Z_]+)/g, '{$1}'));
    out.push({
      dep,
      registrars,
      hasStub: /\bregister\w*DisabledRoutes\(/.test(block + tail),
      // A bare `dep,` or a `dep: value,` line in the deps object is unconditional;
      // anything reached only through a `...(cond ? { dep } : {})` spread is not.
      conditionallyWired:
        !new RegExp(`^\\s+${dep},\\s*$`, 'm').test(boot) &&
        !new RegExp(`^\\s+${dep}:\\s`, 'm').test(boot),
      publishedPaths: [...new Set([...paths, ...templated])].filter((p) => published.has(p)),
    });
  });
  return out;
}

const atRisk = (g: Gate): boolean =>
  !g.hasStub && g.conditionallyWired && g.publishedPaths.length > 0;

describe('every published activation gate ships a disabled stub', () => {
  it('CRITICAL the scan sees a real population and can answer BOTH ways — a census that only ever agrees proves nothing', () => {
    const all = gates();
    expect(
      all.length,
      'no activation gates found — the registration idiom changed',
    ).toBeGreaterThan(15);
    expect(
      all.filter((g) => g.hasStub).map((g) => g.dep),
      'gates WITH a stub must be visible, or the detector cannot tell compliance from absence',
    ).not.toEqual([]);
    expect(
      all.filter((g) => !g.hasStub).map((g) => g.dep),
      'gates WITHOUT a stub must be visible too',
    ).not.toEqual([]);
    // Term 3 must actually discriminate: if every dep read as conditionally wired the
    // join would collapse to "no stub", which is the 17-item false-positive list.
    expect(
      all.filter((g) => !g.conditionallyWired).length,
      'no gate reads as unconditionally wired — the bootstrap join is not discriminating',
    ).toBeGreaterThan(5);
    // Term 4 likewise: something must be excluded by it, or it is decorative.
    expect(
      all.filter((g) => g.publishedPaths.length === 0).map((g) => g.dep),
      'no gate reads as unpublished — the spec join is not discriminating',
    ).not.toEqual([]);
  });

  it('CRITICAL a published operation behind an activation gate answers 503 when the feature is off, or is a listed known gap', () => {
    const unlisted = gates()
      .filter(atRisk)
      .filter((g) => !KNOWN_GAPS.has(g.dep))
      .map((g) => `${g.dep} → ${g.publishedPaths.length} published path(s) that 404 when unwired`);
    expect(
      unlisted,
      'activation gate(s) whose PUBLISHED operations vanish instead of returning 503 — ' +
        'add a register…DisabledRoutes stub and its else branch, or list it in KNOWN_GAPS with the reason',
    ).toEqual([]);
  });

  it('CRITICAL a listed gap is still a gap — closing one deletes its line rather than leaving a permanent exemption', () => {
    const risky = new Set(
      gates()
        .filter(atRisk)
        .map((g) => g.dep),
    );
    const stale = [...KNOWN_GAPS.keys()].filter((dep) => !risky.has(dep));
    expect(
      stale,
      'these are recorded as known gaps but no longer qualify — delete them from KNOWN_GAPS',
    ).toEqual([]);
  });

  it('the gates V-1758 fixed are absent from the at-risk set, so the join reflects the landed fix', () => {
    const risky = gates()
      .filter(atRisk)
      .map((g) => g.dep);
    expect(risky).not.toContain('mfaService');
    expect(risky).not.toContain('cliAuthorizeService');
  });
});
