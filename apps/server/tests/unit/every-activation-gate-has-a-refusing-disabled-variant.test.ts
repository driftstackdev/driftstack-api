// A feature that is switched off still answers, and it answers by refusing.
//
// Seven subsystems are activation-gated: BYOK Anthropic, billing, session
// proxy, agent sessions, recipes, fleet events and the internal atlas-priority
// queue. Each is wired as
//
//     if (deps.thing !== undefined && …) registerThingRoutes(app, …);
//     else                               registerThingDisabledRoutes(app);
//
// The `else` is the part that matters and the part that is easy to leave out.
// Drop it and the paths are simply never registered, so a caller gets a 404 —
// "no such endpoint" — for a feature that exists and is merely unconfigured on
// this deployment. The customer reads that as the API not having the feature;
// the operator reads a support ticket that says the endpoint is missing. A 503
// says the true thing: the feature is real and off here.
//
// The worse variant is a disabled shim that answers 200. A customer calling a
// switched-off subsystem would receive an empty list or a null and treat it as
// data — no sessions, no invoices, no proxies — rather than as an outage. That
// failure is silent on both sides.
//
// Every one of the seven is correct today. This keeps the eighth honest, and
// there will be an eighth: the codebase adds activation-gated subsystems
// regularly, and the disabled half is written last, when the interesting work
// is already done.
//
// DERIVED on both sides. The gates come from scanning `lib/app.ts` for
// `register…DisabledRoutes` calls, and the implementations from the exported
// functions of that name across the route modules, so a new subsystem is
// covered without editing this file — including the case that matters most,
// where someone registers the enabled half and forgets the other.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');
const APP = resolve(SERVER_SRC, 'lib', 'app.ts');
const ROUTES_DIR = resolve(SERVER_SRC, 'routes');

/** `register…DisabledRoutes` names app.ts actually calls. */
function gatesWiredInApp(): string[] {
  const text = readFileSync(APP, 'utf8');
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(register\w*DisabledRoutes)\s*\(/g)) found.add(m[1]!);
  return [...found].sort();
}

interface DisabledImpl {
  file: string;
  name: string;
  body: string;
}

/** Exported `register…DisabledRoutes` implementations across the route modules. */
function disabledImplementations(): DisabledImpl[] {
  const out: DisabledImpl[] = [];
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const text = readFileSync(resolve(ROUTES_DIR, entry), 'utf8');
    for (const m of text.matchAll(/export function (register\w*DisabledRoutes)\s*\(/g)) {
      // Body runs to the next top-level `export ` or end of file, capped so a
      // trailing function cannot absorb the whole module.
      const start = m.index;
      const next = text.indexOf('\nexport ', start + 1);
      const end = next === -1 ? Math.min(start + 6000, text.length) : Math.min(next, start + 6000);
      out.push({ file: entry, name: m[1]!, body: text.slice(start, end) });
    }
  }
  return out;
}

describe('every activation gate has a disabled variant that refuses', () => {
  it('CRITICAL both sides were found and are non-trivial. Each assertion below is "none of these is wrong", and an empty scan has none of anything — a regex that stopped matching would report all seven gates correct having read no gate at all.', () => {
    const wired = gatesWiredInApp();
    const impls = disabledImplementations();

    // MEASURED: 7 gates wired in app.ts, 7 implementations across the route
    // modules — BYOK, billing, session proxy, agent sessions, recipes, fleet
    // events, internal atlas-priority.
    expect(wired.length, 'disabled variants wired in app.ts').toBeGreaterThanOrEqual(7);
    expect(impls.length, 'disabled variants implemented in routes/').toBeGreaterThanOrEqual(7);
    expect(
      impls.every((i) => i.body.length > 80),
      'and each implementation body was captured, not an empty slice',
    ).toBe(true);
  });

  it('CRITICAL every disabled variant app.ts wires actually exists. A gate calling a function nobody exports would not compile, but a gate wired to the WRONG module still would — and the failure only shows on a deployment where that subsystem is off, which is the deployment least likely to be exercised before release.', () => {
    const implemented = new Set(disabledImplementations().map((i) => i.name));
    const dangling = gatesWiredInApp()
      .filter((name) => !implemented.has(name))
      .sort();
    expect(dangling, 'disabled variant(s) wired in app.ts with no implementation:').toEqual([]);
  });

  it('CRITICAL every disabled variant REFUSES rather than answering. A shim returning 200 hands a customer an empty list for a switched-off subsystem — no sessions, no invoices, no proxies — which reads as data rather than as an outage, and is silent on both sides.', () => {
    const notRefusing = disabledImplementations()
      .filter((i) => !i.body.includes('FeatureUnavailableError'))
      .map((i) => `${i.file} ${i.name}`)
      .sort();
    expect(notRefusing, 'disabled variant(s) that do not throw FeatureUnavailableError:').toEqual(
      [],
    );
  });

  it('CRITICAL every disabled variant registers at least one route. An empty implementation type-checks, satisfies the arm above vacuously by having no route to answer wrongly, and leaves the paths 404ing — the exact outcome the disabled variant exists to prevent, reached by writing one rather than omitting it.', () => {
    const empty = disabledImplementations()
      .filter((i) => !/app\.(get|post|put|patch|delete|all)\s*[<(]/.test(i.body))
      .map((i) => `${i.file} ${i.name}`)
      .sort();
    expect(empty, 'disabled variant(s) registering no route at all:').toEqual([]);
  });
});
