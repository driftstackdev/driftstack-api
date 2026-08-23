// Runs the published Go SDK against a real server and proves it RAN.
//
// The third and last SDK. `packages/sdk-go` has 25 test files; two stand up an
// `httptest` server, which is still a stub the test author wrote rather than
// the API this client wraps.
//
// Go's failure mode is the quietest of the three. The client decodes into
// concrete structs with explicit json tags, so a server that renames a field
// does not error — it leaves the Go zero value in place, and the customer reads
// an empty string or a nil slice from a call that returned 200. The Go cases
// therefore assert on emptiness, not just on `err == nil`.
//
// `go test` reports `PASS` and `ok` for a package whose tests ALL skipped, and
// exits 0 doing it. So this harness counts the per-test `--- PASS` / `--- SKIP`
// lines instead of trusting the exit code — the same false green the Python
// harness guards, and here the summary line actively encourages it.

import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SDK_DIR = resolve(REPO_ROOT, 'packages/sdk-go');

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let baseUrl: string;

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
  await fx.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = fx.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port.toString()}`;
});

afterAll(async () => {
  await fx.app.close();
});

interface GoRun {
  out: string;
  status: number | null;
  passed: number;
  skipped: number;
  failed: number;
}

/**
 * ASYNC deliberately — see the Python harness. The server under test runs in
 * this node process, so a synchronous spawn would block the event loop that has
 * to answer the child's HTTP requests, and the two would wait on each other
 * until the timeout.
 */
async function runGoTests(): Promise<GoRun> {
  const proc = spawn('go', ['test', '-count=1', '-run', 'TestLive', '-v', '.'], {
    cwd: SDK_DIR,
    env: { ...process.env, DS_LIVE_BASE_URL: baseUrl, DS_LIVE_API_KEY: fx.plaintext },
  });

  let out = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c: string) => (out += c));
  proc.stderr.on('data', (c: string) => (out += c));

  const status = await new Promise<number | null>((res, rej) => {
    const kill = setTimeout(() => {
      proc.kill('SIGKILL');
    }, 180_000);
    proc.on('error', (e) => {
      clearTimeout(kill);
      rej(e);
    });
    proc.on('close', (code) => {
      clearTimeout(kill);
      res(code);
    });
  });

  const count = (re: RegExp): number => (out.match(re) ?? []).length;
  return {
    out,
    status,
    passed: count(/^\s*--- PASS: TestLive/gm),
    skipped: count(/^\s*--- SKIP: TestLive/gm),
    failed: count(/^\s*--- FAIL: TestLive/gm),
  };
}

describe('the published Go SDK works against the real server', () => {
  it('CRITICAL the Go toolchain is present and the package builds. Without this the harness below could report a clean pass on a run that never compiled the SDK.', async () => {
    const build = spawn('go', ['build', './...'], { cwd: SDK_DIR });
    let err = '';
    build.stderr.setEncoding('utf8');
    build.stderr.on('data', (c: string) => (err += c));
    const code = await new Promise<number | null>((res, rej) => {
      build.on('error', rej);
      build.on('close', res);
    });
    expect(code, `go build failed:\n${err}`).toBe(0);
  }, 180_000);

  it('CRITICAL the live contract tests RUN — not skip — and all pass. Counted per test, because `go test` prints PASS and ok for a package whose tests every one skipped, and exits 0 while doing it.', async () => {
    const run = await runGoTests();

    expect(run.failed, `Go SDK failed against the real server:\n${run.out}`).toBe(0);
    expect(run.skipped, `the live Go tests SKIPPED, so nothing was verified:\n${run.out}`).toBe(0);
    expect(run.passed, `expected the live Go cases to run:\n${run.out}`).toBeGreaterThanOrEqual(9);
    expect(run.status, 'and go test exits clean').toBe(0);
  }, 180_000);
});
