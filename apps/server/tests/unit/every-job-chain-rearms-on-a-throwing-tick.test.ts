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

import { EVENT_STARTED_JOB_TYPES } from '../../src/services/job-chain-liveness.js';

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

/**
 * V-1629 — the chain must also START, which is a different property.
 *
 * The arms below prove a chain SURVIVES a throwing tick. They cannot see a
 * chain that never ran: a job type whose handler is registered but whose first
 * run is never enqueued has no pending row, so the poller never calls it and
 * nothing errors. That is the shape `tick-services-are-wired-invariant` was
 * written for — "the fourteenth is complete, has DB columns, has an email
 * template, has its own tests, and is wired nowhere" — but that file scans for
 * `tickOnce(...)` services, and these chains use `scheduledJobs.register(...)`
 * plus a seed `enqueue`. Different shape, same failure, no coverage.
 */
function registeredJobTypes(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(SERVICES).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(resolve(SERVICES, f), 'utf8');
    for (const m of src.matchAll(/scheduledJobs\.register\(\s*([A-Z_][A-Z0-9_]*)/g))
      out.add(m[1] ?? '');
  }
  return out;
}

/** jobType each `enqueueNext…` helper enqueues, from the helper's own source. */
function helperJobTypes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SERVICES).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(resolve(SERVICES, f), 'utf8');
    for (const m of src.matchAll(
      /export async function (enqueue\w+)\([\s\S]{0,900}?jobType:\s*([A-Z_][A-Z0-9_]*)/g,
    ))
      out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

/** The string each `*_JOB_TYPE` constant holds, from the services' own source. */
function jobTypeValues(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SERVICES).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(resolve(SERVICES, f), 'utf8');
    for (const m of src.matchAll(
      /export const ([A-Z_]*JOB_TYPE[A-Z_]*)\s*(?::[^=]*)?=\s*'([a-z_.]+)'/g,
    ))
      out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

/**
 * Services files, other than the one that defines it, that call an `enqueue…`
 * helper. An event-started job has no seed at boot; THIS is its start, and a
 * helper nobody else calls is a job that never runs.
 */
function callersOutsideItsOwnFile(helper: string): string[] {
  return readdirSync(SERVICES)
    .filter((n) => n.endsWith('.ts'))
    .filter((f) => {
      const src = readFileSync(resolve(SERVICES, f), 'utf8');
      return (
        !src.includes(`export async function ${helper}(`) && new RegExp(`\\b${helper}\\(`).test(src)
      );
    });
}

/** Job types bootstrap actually seeds, via the helpers it awaits. */
function seededJobTypes(): Set<string> {
  const boot = readFileSync(resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts'), 'utf8');
  const byName = helperJobTypes();
  const out = new Set<string>();
  for (const m of boot.matchAll(/await (enqueue\w+)\(/g)) {
    const t = byName.get(m[1] ?? '');
    if (t !== undefined) out.add(t);
  }
  return out;
}

describe('a recurring sweep re-arms even when its tick throws', () => {
  const helpers = registerHelpers();

  it('CRITICAL the scan found the helpers, so a green means checked rather than nothing found', () => {
    // Floor below the measured 13. Without this, a rename of the `register*Job`
    // convention empties the population and every check below passes vacuously.
    // 12 → 13 with registerCryptoOrderExpirySweepJob (the abandoned-pending-
    // order sweep, which had no scheduler at all until 2026-08-23).
    // 13 → 14 with registerSessionEventsArchiveJob (V-1591 — the 90-day
    // session_events archive, which had never run at all).
    // 14 → 15 with registerProxyFreshnessJob (ITEM 4 — the background refresh of
    // a saved proxy's exit identity and OS fingerprint, which nothing re-took
    // after the one Test that first measured it).
    // 15 → 16 with registerAgentTurnTelemetryPruneJob (the 90-day retention of
    // the per-request AI diagnostics rows).
    // 16 → 17 with registerAgentTurnHealthWatchdogJob (the AI turn health
    // conditions evaluated from the diagnostics table and sent to Sentry).
    // 17 → 20 with the three monthly AI credits jobs: the coverage sweep, the
    // expiry sweep, and the per-account window-boundary job (which re-arms
    // itself every 5 minutes while the next month is unpaid, so a throwing tick
    // must not end it either).
    expect(
      helpers.map((h) => h.name).sort(),
      'the register*Job scan came back short — the checks below cover only what it found',
    ).toHaveLength(20);
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

  it('V-1629 CRITICAL every registered job type is also SEEDED at bootstrap, so the chain starts as well as survives. A handler registered with no first run enqueued has no pending row, the poller never calls it, and nothing errors — the sweep simply never runs, which is exactly how a completed feature sat wired-nowhere before. Both sets are derived: registrations from services/*.ts, seeds from the enqueueNext helpers bootstrap awaits, resolved to the jobType each helper actually enqueues rather than to its name.', () => {
    const registered = registeredJobTypes();
    const seeded = seededJobTypes();

    // Vacuity on both readers: two empty sets are equal, and this arm's healthy
    // result is an empty difference, so emptiness can never be the alarm.
    expect(registered.size, 'job-type registrations found in services/').toBeGreaterThanOrEqual(10);
    expect(seeded.size, 'seed helpers resolved from bootstrap').toBeGreaterThanOrEqual(10);

    // A job started by an EVENT rather than at boot (one row per account, armed
    // when that account is granted a credit window) has no seed to find. It is
    // excused by name in job-chain-liveness.ts, and held to the same question
    // asked another way: something outside its own file must arm it.
    const values = jobTypeValues();
    const eventStarted = new Set(
      [...registered].filter((t) => EVENT_STARTED_JOB_TYPES.has(values.get(t) ?? '')),
    );
    expect(
      [...registered].filter((t) => !seeded.has(t) && !eventStarted.has(t)).sort(),
      'these job types have a registered handler but nothing enqueues a first run, so the chain never starts:',
    ).toEqual([]);

    const helpersByType = new Map<string, string[]>();
    for (const [helper, t] of helperJobTypes())
      helpersByType.set(t, [...(helpersByType.get(t) ?? []), helper]);
    const neverArmed = [...eventStarted]
      .filter((t) => (helpersByType.get(t) ?? []).flatMap(callersOutsideItsOwnFile).length === 0)
      .sort();
    expect(
      neverArmed,
      'event-started job types whose enqueue helper no other service calls, so the job never runs:',
    ).toEqual([]);
    expect(
      [...eventStarted].filter((t) => seeded.has(t)).sort(),
      'excused as event-started, but bootstrap seeds it: it is a chain, so take it off that list:',
    ).toEqual([]);
    expect(
      [...EVENT_STARTED_JOB_TYPES.keys()].filter((v) => ![...values.values()].includes(v)).sort(),
      'event-started job types no service declares any more:',
    ).toEqual([]);

    expect(
      [...seeded].filter((t) => !registered.has(t)).sort(),
      'bootstrap seeds these job types but no service registers a handler for them, so the row is picked up and dropped:',
    ).toEqual([]);
  });
});
