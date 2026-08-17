// Every recurring sweep re-arms on the path where its work THREW.
//
// These chains have no external scheduler. Each tick enqueues its own
// successor, so the chain exists only as long as every tick re-arms — and the
// helpers say so themselves: "the self-re-arming chain is dead until a process
// restart and cost alerting silently stops forever".
//
// The failure is specifically the throwing path. A handler that enqueues its
// successor as the last statement of `try { … }` works perfectly in every test
// and every normal night; the first tick that throws skips the enqueue, the
// poller retries to maxAttempts, `markFailed` leaves no pending row, and the
// sweep stops running. Nothing errors at the moment it matters. Among these
// chains are three privacy-policy §9 retention commitments and the reconciler
// that recovers paid crypto customers whose entitlement never landed.
//
// `job-chain-liveness` already DETECTS this — a dead chain reports 0 rather
// than an absent series. That is the right safety net and it is not the same
// property: it fires after a chain has already died, on a dashboard someone has
// to be watching. This one makes the shape unwriteable.
//
// Measured across all twelve helpers, the property holds today by two different
// shapes, which is why this checks reachability rather than pinning a layout:
//
//   eleven helpers   try { work } catch { log }, then re-arm AFTER the catch
//   cost-nightly     re-arms in every branch of the try AND again in the catch,
//                    deliberately not in `finally` — its comment explains that a
//                    `finally` re-arm fans out, because every poller retry would
//                    re-arm and duplicate the chain
//
// So the test deletes each try-block body — precisely what a throw skips — and
// requires an enqueue to survive in what remains.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(HERE, '..', '..', 'src', 'services');

/** Index of the `}` closing the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * What of `body` still runs when the work inside `try { … }` throws. Every
 * try-block body is removed; catch blocks and anything after them remain.
 */
function reachableAfterThrow(body: string): string {
  let rest = body;
  for (;;) {
    const t = rest.indexOf('try {');
    if (t === -1) return rest;
    const close = matchBrace(rest, rest.indexOf('{', t));
    if (close === -1) return rest;
    rest = rest.slice(0, t) + rest.slice(close + 1);
  }
}

interface Helper {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

function registerHelpers(): Helper[] {
  const out: Helper[] = [];
  for (const file of readdirSync(SERVICES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(SERVICES, file), 'utf8');
    for (const m of src.matchAll(/export function (register\w*Job)\(/g)) {
      const sig = src.indexOf('):', m.index ?? 0);
      const open = src.indexOf('{', sig);
      const close = matchBrace(src, open);
      if (open === -1 || close === -1) continue;
      out.push({ file, name: m[1] ?? '', body: src.slice(open, close + 1) });
    }
  }
  return out;
}

describe('a recurring sweep re-arms even when its tick throws', () => {
  const helpers = registerHelpers();

  it('CRITICAL the scan found the helpers, so a green means checked rather than nothing found', () => {
    // Floor below the measured 12. Without this, a rename of the `register*Job`
    // convention empties the population and every check below passes vacuously.
    expect(
      helpers.map((h) => h.name).sort(),
      'the register*Job scan came back short — the checks below cover only what it found',
    ).toHaveLength(12);
  });

  it('the detector detects — it must flag the broken shape and clear both working ones', () => {
    // Anti-vacuity on the INSTRUMENT. `reachableAfterThrow` is the whole test;
    // if it silently returned the untouched body, every helper would pass.
    const broken = `{ try { await work(); await enqueueNextThing({}); } catch (err) { log(err); } }`;
    const afterCatch = `{ try { await work(); } catch (err) { log(err); } await enqueueNextThing({}); }`;
    const inCatch = `{ try { await work(); await enqueueNextThing({}); } catch (err) { await enqueueNextThing({}); } }`;
    expect(reachableAfterThrow(broken)).not.toContain('enqueueNext');
    expect(reachableAfterThrow(afterCatch)).toContain('enqueueNext');
    expect(reachableAfterThrow(inCatch)).toContain('enqueueNext');
    // And the brace matcher must not stop at the first nested close.
    const nested = `{ try { if (x) { await work(); } } catch (e) { await enqueueNextThing({}); } }`;
    expect(reachableAfterThrow(nested)).toContain('enqueueNext');
  });

  it('CRITICAL every helper wraps its work, so a throw cannot escape to the poller', () => {
    // An unwrapped throw propagates, the poller burns maxAttempts, and markFailed
    // leaves no pending row — the same dead chain by a different route.
    const unwrapped = helpers.filter((h) => !h.body.includes('try {')).map((h) => h.name);
    expect(
      unwrapped,
      'a job handler does not catch its own failure, so a throwing tick escapes to the poller and ' +
        'the chain dies once maxAttempts is exhausted',
    ).toEqual([]);
  });

  it('CRITICAL every helper re-arms on the throwing path, not only on the happy one', () => {
    const dead = helpers
      .filter((h) => !reachableAfterThrow(h.body).includes('enqueueNext'))
      .map((h) => `${h.file}: ${h.name}`);
    expect(
      dead,
      'this sweep enqueues its successor only inside `try`, so the first tick that throws is the ' +
        'last one that ever runs: the chain is dead until a process restart, silently, with no ' +
        'error at the moment it matters. Re-arm after the catch, or again inside it',
    ).toEqual([]);
  });
});
