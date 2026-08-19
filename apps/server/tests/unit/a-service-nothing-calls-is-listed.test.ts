// V-1055 — a service bootstrap constructs but nothing ever calls is on a list.
//
// V-1054 found `SocksProxyBackend` instantiated in bootstrap, handed to
// `routes/session-proxy.ts`, and never called — while two comments elsewhere
// described the 4xx a customer supposedly receives from it. The wiring was honest in
// bootstrap and dishonest in the files that described the outcome, which is the worst
// arrangement: the truth existed and was not where anyone reading about the behaviour
// would look.
//
// The general shape is worth catching, because a constructed-but-uncalled service
// reads as shipped from every angle that is cheap to check. It appears in bootstrap,
// it is covered by its own unit tests, it type-checks against the interface, and its
// dependencies resolve. Nothing about it looks pending.
//
// Measured today: 105 `const x = new Y(` constructions in bootstrap, of which exactly
// one has no caller for any public method — the one V-1054 documented. So this file
// starts green with a single-entry list, and what it refuses is the second one.
//
// ── The detector, and what it is not ───────────────────────────────────────
//
// A method counts as called if `.name(` appears in any server source file other than
// the class's own. That is deliberately crude, and it is the reason the first arm
// exists: it is a text search, so a method invoked only through a dynamically built
// name would read as uncalled, and a method sharing a name with an unrelated one
// would read as called.
//
// Both directions are self-tested below against known cases rather than argued. The
// crudeness is acceptable because the failure this guards against is coarse: not "is
// this method reachable on every path" but "did anyone ever wire this at all".

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Services constructed in bootstrap that nothing calls, with the reason each is
 * acceptable.
 *
 * `SocksProxyBackend` — Phase 1 SOCKS5 egress. Instantiated eagerly so the route
 * surface activates, but `routes/session-proxy.ts` holds it without calling it and
 * `applyToSession` has no caller anywhere; bootstrap.ts says so at its construction
 * site. Wiring the session-create edge is planning-133 work. V-1054 corrected the two
 * comments that described a customer-visible 4xx coming out of it, and recorded the
 * two further gaps that wiring will have to close (it rejects with a plain Error
 * rather than a Problem, and its problem-type URIs are not in PROBLEM_TYPES).
 */
const UNCALLED_BY_DESIGN: ReadonlySet<string> = new Set(['SocksProxyBackend']);

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

const FILES = serverFiles();
const SOURCES = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
const BOOTSTRAP = readFileSync(resolve(SRC, 'lib/bootstrap.ts'), 'utf8');

/** Class names bootstrap constructs into a const. */
function constructedInBootstrap(): string[] {
  return [...new Set([...BOOTSTRAP.matchAll(/const \w+\s*=\s*new (\w+)\(/g)].map((m) => m[1]!))];
}

/** The file declaring `cls`, if it is one of ours. */
function homeOf(cls: string): string | undefined {
  const re = new RegExp(`(?:export )?(?:abstract )?class ${cls}\\b`);
  return FILES.find((f) => re.test(SOURCES.get(f)!));
}

/** Public method names on the class, excluding the constructor. */
function methodsOf(home: string): string[] {
  const src = SOURCES.get(home)!;
  const found = new Set([...src.matchAll(/^ {2}(?:async\s+)?(\w+)\s*\(/gm)].map((m) => m[1]!));
  found.delete('constructor');
  return [...found];
}

/** Classes whose every public method is uncalled outside their own file. */
function neverCalled(): string[] {
  const out: string[] = [];
  for (const cls of constructedInBootstrap()) {
    const home = homeOf(cls);
    if (home === undefined) continue;
    const methods = methodsOf(home);
    if (methods.length === 0) continue;
    const elsewhere = FILES.filter((f) => f !== home)
      .map((f) => SOURCES.get(f)!)
      .join('\n');
    if (methods.every((m) => !elsewhere.includes(`.${m}(`))) out.push(cls);
  }
  return out.sort();
}

describe('V-1055 a service nothing calls is listed', () => {
  it('CRITICAL the walk and the detector both work. A bootstrap scan that matched nothing, or a call detector that reported everything as called, would make the arm below agree with a server where nothing is wired to anything.', () => {
    const constructed = constructedInBootstrap();
    expect(FILES.length, 'server source files walked').toBeGreaterThanOrEqual(200);
    expect(constructed.length, 'classes constructed in bootstrap').toBeGreaterThanOrEqual(80);

    // A service with obvious callers must NOT be reported…
    const called = neverCalled();
    expect(
      constructed,
      'WebhooksService is no longer constructed in bootstrap, so it can no longer serve as the ' +
        'known-called control for this detector',
    ).toContain('WebhooksService');
    expect(
      called,
      'WebhooksService was reported as uncalled — the detector is broken',
    ).not.toContain('WebhooksService');

    // …and the detector must still be capable of reporting something, or the arm
    // below passes for a reason unrelated to wiring.
    //
    // This has two readings and the message names both, because one of them is
    // good news. Either the detector broke, or the last listed service was finally
    // wired — in which case this file has done its job and should be retired in the
    // same commit rather than left asserting over an empty set.
    expect(
      called,
      'the detector reported nothing at all. Either it is broken, or every service in ' +
        'UNCALLED_BY_DESIGN has since been wired — if the latter, delete this file and the ' +
        'entry together, and revisit the comments that describe those services as pending',
    ).not.toEqual([]);
  });

  it('CRITICAL every constructed-but-uncalled service is listed with a reason. Such a service reads as shipped from every cheap angle — it is in bootstrap, its own unit tests pass, it type-checks against its interface — while no customer request reaches it, which is how V-1054 came to describe a 4xx nobody could receive.', () => {
    const unlisted = neverCalled().filter((c) => !UNCALLED_BY_DESIGN.has(c));
    expect(
      unlisted,
      'these services are constructed in bootstrap and no public method of theirs is called ' +
        'anywhere — wire them, delete them, or add them here with the reason and the work that ' +
        'would close it:',
    ).toEqual([]);
  });

  it('CRITICAL the list holds no stale entry. A service that has since been wired would sit here reading as a known gap, and would pre-approve the next thing that lands under that name.', () => {
    const live = new Set(neverCalled());
    expect(
      [...UNCALLED_BY_DESIGN].filter((c) => !live.has(c)).sort(),
      'listed as uncalled but now has a caller — good, and the comments describing it as pending ' +
        'should be revisited with the entry:',
    ).toEqual([]);
  });
});
