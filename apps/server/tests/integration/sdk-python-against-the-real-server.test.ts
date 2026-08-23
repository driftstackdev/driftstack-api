// Runs the published Python SDK against a real server and proves it RAN.
//
// `packages/sdk-python` has 31 test files, 22 of them mocking the transport,
// and not one has ever opened a socket to the API it wraps. The TypeScript SDK
// had the same gap until 10049bcc5; this closes the second of the three.
//
// It matters more here, because this client PARSES. Every resource method
// funnels its 2xx body through `parse_model` -> pydantic -> `TransportError`,
// so a server field the generated models do not describe raises in the
// customer's process on a call that SUCCEEDED. A mocked test cannot reach that
// path: it feeds the parser the body the test author wrote.
//
// The Python side lives in `packages/sdk-python/tests/test_live_contract.py`
// and skips itself unless DS_LIVE_BASE_URL + DS_LIVE_API_KEY are set, so
// `pytest` stays runnable standalone. That skip is also the danger: a test that
// silently skips forever is a false green wearing a passing badge. So this
// harness asserts on the collected counts — tests ran, none were skipped, none
// errored — rather than on the exit code, which is 0 for a fully-skipped run.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SDK_DIR = resolve(REPO_ROOT, 'packages/sdk-python');
const PYTHON = resolve(SDK_DIR, '.venv/bin/python');

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let baseUrl: string;

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
  // A real listener: the subprocess is a separate OS process and cannot reach
  // an in-process inject().
  await fx.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = fx.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port.toString()}`;
});

afterAll(async () => {
  await fx.app.close();
});

interface PytestRun {
  stdout: string;
  status: number | null;
  counts: Record<string, number>;
}

/**
 * Must be ASYNC, and that is not a style preference.
 *
 * The server under test runs in THIS node process. `spawnSync` blocks the event
 * loop, so the pytest child's HTTP requests arrive at a listener that cannot
 * answer them until the child exits — which it never does, because it is
 * waiting on those requests. The first version of this harness deadlocked
 * exactly that way and spent its whole 120s timeout before reporting "no tests
 * ran", which reads like a collection failure rather than a self-inflicted one.
 */
async function runPytest(): Promise<PytestRun> {
  const proc = spawn(PYTHON, ['-m', 'pytest', 'tests/test_live_contract.py', '-v'], {
    cwd: SDK_DIR,
    env: {
      ...process.env,
      DS_LIVE_BASE_URL: baseUrl,
      DS_LIVE_API_KEY: fx.plaintext,
    },
  });

  let out = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c: string) => (out += c));
  proc.stderr.on('data', (c: string) => (out += c));

  const status = await new Promise<number | null>((res, rej) => {
    const kill = setTimeout(() => {
      proc.kill('SIGKILL');
    }, 120_000);
    proc.on('error', (e) => {
      clearTimeout(kill);
      rej(e);
    });
    proc.on('close', (code) => {
      clearTimeout(kill);
      res(code);
    });
  });

  const stdout = out;
  // pytest's summary line: "4 passed in 0.42s", "1 failed, 3 passed in ...".
  const counts: Record<string, number> = {};
  for (const m of stdout.matchAll(/(\d+) (passed|failed|skipped|error|errors|xfailed)/g)) {
    counts[m[2] === 'errors' ? 'error' : (m[2] ?? '')] = Number(m[1]);
  }
  return { stdout, status, counts };
}

describe('the published Python SDK works against the real server', () => {
  it('CRITICAL the interpreter and the SDK are actually installed. Without this the harness below would report a clean pass on a run that never imported the package.', () => {
    expect(existsSync(PYTHON), `python venv present at ${PYTHON}`).toBe(true);
    const probe = spawnSync(PYTHON, ['-c', 'import driftstack; print(driftstack.__file__)'], {
      cwd: SDK_DIR,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(probe.status, `import driftstack failed: ${probe.stderr ?? ''}`).toBe(0);
  });

  it('CRITICAL the live contract suite RUNS — not skips — and every case passes. Asserted on the collected counts rather than the exit code, because a fully-skipped pytest run also exits 0, which is exactly how a permanently-skipped contract test hides.', async () => {
    const run = await runPytest();

    expect(run.counts['error'] ?? 0, `pytest collection errors:\n${run.stdout}`).toBe(0);
    expect(
      run.counts['skipped'] ?? 0,
      `the live suite SKIPPED, so nothing was verified:\n${run.stdout}`,
    ).toBe(0);
    expect(
      run.counts['passed'] ?? 0,
      `expected the live contract cases to run:\n${run.stdout}`,
    ).toBeGreaterThanOrEqual(6);
    expect(run.counts['failed'] ?? 0, `python SDK failed against the server:\n${run.stdout}`).toBe(
      0,
    );
    expect(run.status, 'and pytest exits clean').toBe(0);
  }, 180_000);
});
