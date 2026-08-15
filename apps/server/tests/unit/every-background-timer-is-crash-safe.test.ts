// Every background timer survives a bad tick, releases the event loop, and is
// cleared on shutdown.
//
// bootstrap.ts runs eleven `setInterval` pollers — scheduled jobs, validation
// harness, health probes, status snapshots, subscriber purge, two rotation
// reminders, pair-mode heartbeat sweep, webhook delivery, grace notices, and
// secret cleanup. All eleven hold all three properties today. Nothing asserted
// any of them, and each has a distinct and severe failure mode:
//
//   async callback     `setInterval(async () => …)` returns a promise nobody
//                      awaits. A rejected tick is an unhandled rejection, which
//                      TERMINATES the process on modern Node — one bad tick
//                      takes the server down rather than logging a warning.
//
//   no try/catch       same outcome by a different route: the throw escapes the
//                      async IIFE and nothing is there to catch it. The existing
//                      code says so in its own comment — "an unexpected throw
//                      must NEVER kill the interval".
//
//   no .unref()        the timer holds the event loop open, so the process does
//                      not exit on SIGINT until the next tick fires. On a 60s
//                      poller that is a minute of hang per deploy.
//
//   no clearInterval   the poller keeps running through teardown, doing database
//                      work against a pool that is closing.
//
// This is a structural guard over one file rather than a behavioural one, and
// that is deliberate: the failure it prevents is someone ADDING a twelfth timer
// in the wrong shape, which no behavioural test of the existing eleven would
// notice.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = resolve(HERE, '..', '..', 'src', 'lib', 'bootstrap.ts');

const source = (): string => readFileSync(BOOTSTRAP, 'utf8');

/** Every `const <name>Timer = setInterval(` / `= <cond> ? setInterval(` site. */
function timerNames(src: string): string[] {
  return [...src.matchAll(/const (\w*[Tt]imer\w*)\s*=/g)]
    .map(([, name]) => name)
    .filter((n): n is string => n !== undefined);
}

/**
 * The body of each `setInterval(` call, brace-matched from its opening paren.
 *
 * Brace-matched rather than windowed: these bodies run to 40+ lines and a fixed
 * character window would either truncate one or spill into the next timer,
 * which is how a scan like this reports the wrong answer confidently.
 */
function intervalBodies(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/setInterval\(/g)) {
    const open = src.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(src.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

describe('every background timer is crash-safe', () => {
  it('CRITICAL the scan found the pollers. Every arm below reports "none violating", and a scan that matched nothing has none of anything — it would pass having read no timers at all.', () => {
    const src = source();
    // MEASURED: 11 setInterval pollers, 11 timer consts.
    expect(intervalBodies(src).length, 'setInterval bodies brace-matched').toBeGreaterThanOrEqual(
      11,
    );
    expect(timerNames(src).length, 'timer consts found').toBeGreaterThanOrEqual(11);
    // And the matcher must actually capture a body, not an empty slice.
    expect(
      intervalBodies(src).every((b) => b.length > 40),
      'each body is a real block',
    ).toBe(true);
  });

  it('CRITICAL no timer passes an async function straight to setInterval. That returns a promise nobody awaits, so a rejected tick becomes an unhandled rejection — which terminates the process on modern Node. One transient database error would take the server down instead of logging a warning.', () => {
    const offenders = [...source().matchAll(/setInterval\(\s*async\b/g)].map((m) =>
      String(m.index),
    );
    expect(offenders, 'setInterval site(s) given an async callback:').toEqual([]);
  });

  it('CRITICAL every timer body opens its error handling BEFORE the first await. The file states the rule itself — "an unexpected throw must NEVER kill the interval" — and a throw escaping the async IIFE reaches the same unhandled-rejection exit as an async callback would. Position matters and a substring does not prove it: a body can contain the word `try` after the awaited call, or in a branch that never runs, and still leave the real work unguarded. This asserts the guard is open at the point the work happens.', () => {
    const unguarded = intervalBodies(source())
      .map((body, i) => {
        const firstAwait = body.indexOf('await ');
        if (firstAwait === -1) return { i, guarded: true }; // nothing async to protect
        const guardOpens = [body.indexOf('try {'), body.indexOf('.catch(')].filter((x) => x !== -1);
        const earliest = guardOpens.length === 0 ? -1 : Math.min(...guardOpens);
        return { i, guarded: earliest !== -1 && earliest < firstAwait };
      })
      .filter((b) => !b.guarded)
      .map((b) => `setInterval body #${String(b.i + 1)}`);
    expect(unguarded, 'timer body/bodies whose awaited work is unguarded:').toEqual([]);
  });

  it('CRITICAL every timer is unref()ed. A referenced interval holds the event loop open, so the process does not exit on SIGINT until the next tick — a minute of hang per deploy on a 60s poller, and the shutdown path already budgets far less than that.', () => {
    const src = source();
    const missing = timerNames(src).filter(
      (n) => !src.includes(`${n}.unref()`) && !src.includes(`${n}?.unref()`),
    );
    expect(missing, 'timer(s) never unref()ed:').toEqual([]);
  });

  it('CRITICAL every timer is cleared on shutdown. A poller that survives teardown keeps doing database work against a pool that is closing, which surfaces as errors attributed to the shutdown rather than to the timer.', () => {
    const src = source();
    const missing = timerNames(src).filter(
      (n) => !src.includes(`clearInterval(${n})`) && !src.includes(`clearInterval(${n}!)`),
    );
    expect(missing, 'timer(s) never cleared:').toEqual([]);
  });
});
