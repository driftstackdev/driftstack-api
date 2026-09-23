// A worker repeats its latest fault on every heartbeat until it faults again,
// so the server must log each DISTINCT fault once, not once per beat — in
// production one fault became 7,873 identical warnings in a day. What holds:
//   · the first beat carrying a fault is logged; the same fault on the next
//     beats is not;
//   · a different summary, or the same summary at a new time, is a new fault
//     and is logged;
//   · each node is tracked on its own;
//   · a worker that sends no timestamp is logged once per summary;
//   · the wiring: bootstrap only logs a beat's fault when the helper says it
//     is new (read from the code with comments stripped).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { isNewWorkerFault, resetWorkerFaultLog } from '../../src/lib/worker-fault-log.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = resolve(HERE, '../../src/lib/bootstrap.ts');

beforeEach(() => resetWorkerFaultLog());

describe('a worker fault repeated on every heartbeat is logged once', () => {
  it('CRITICAL the first beat with a fault is logged and every repeat of it is not', () => {
    const at = 1_790_014_998_340.8762;
    expect(isNewWorkerFault('mac-1', 'proxy_connection_failed', at)).toBe(true);
    for (let beat = 0; beat < 100; beat++) {
      expect(isNewWorkerFault('mac-1', 'proxy_connection_failed', at)).toBe(false);
    }
  });

  it('a different summary, or the same summary at a new time, is a new fault', () => {
    expect(isNewWorkerFault('mac-1', 'proxy_connection_failed', 1)).toBe(true);
    expect(isNewWorkerFault('mac-1', 'proxy_connection_failed', 2)).toBe(true);
    expect(isNewWorkerFault('mac-1', 'WebProcess terminated unexpectedly', 2)).toBe(true);
    expect(isNewWorkerFault('mac-1', 'WebProcess terminated unexpectedly', 2)).toBe(false);
  });

  it('each node is tracked on its own', () => {
    expect(isNewWorkerFault('mac-1', 'x', 5)).toBe(true);
    expect(isNewWorkerFault('mac-2', 'x', 5)).toBe(true);
    expect(isNewWorkerFault('mac-1', 'x', 5)).toBe(false);
    expect(isNewWorkerFault('mac-2', 'x', 5)).toBe(false);
  });

  it('a worker that sends no timestamp is logged once per summary', () => {
    expect(isNewWorkerFault('mac-1', 'x')).toBe(true);
    expect(isNewWorkerFault('mac-1', 'x')).toBe(false);
    expect(isNewWorkerFault('mac-1', 'y')).toBe(true);
  });

  it("CRITICAL bootstrap logs a beat's fault only when the helper says it is new", () => {
    const code = codeOnly(readFileSync(BOOTSTRAP, 'utf8'));
    const at = code.indexOf("'worker reported a recent fault on its heartbeat'");
    expect(at, 'the heartbeat fault log line is still in bootstrap').toBeGreaterThan(-1);
    const before = code.slice(Math.max(0, at - 800), at);
    expect(before).toMatch(
      /frame\.lastErrorSummary !== undefined &&\s*isNewWorkerFault\(frame\.macNodeId, frame\.lastErrorSummary, frame\.lastErrorAtMs\)/,
    );
  });
});
