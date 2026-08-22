// `post-deploy-verify.mjs` is what fires auto-revert, and nothing executed it.
//
// deploy-bridge.sh runs this script after a deploy and, on a non-zero exit,
// invokes revert-bridge.sh against the recorded .last-good-sha (V-549.B). So the
// exit code IS the rollback trigger: if a check silently reported ok, or the
// exit code stopped tracking the results, a broken deploy would verify clean and
// stay live with no operator involved.
//
// Four test files referenced this script before this one. All four were
// content-parity or runbook prose — they pin what the file SAYS, and none ran
// it. A comment cannot fail, and neither can a docs pin.
//
// The check singled out here is the sha match. It is the one that answers "did
// the new build actually land", which is precisely the failure a deploy cannot
// self-detect: every other endpoint can look perfectly healthy while serving
// the previous artifact.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/post-deploy-verify.mjs');

const DEPLOYED_SHA = 'a1b2c3d';
// The production posture (#21): DRIVER=mock is DELIBERATE there -- browser work
// runs on the fleet, not in-process -- which is exactly why this is asserted
// here instead of guarded at boot, where refusing mock would brick the deploy.
const DEPLOYED_DRIVER = 'mock';
const DEPLOYED_AGENT_EXECUTION = 'live';

interface VerifyReport {
  ok: boolean;
  pass: number;
  fail: number;
  checks: Array<{ ok: boolean; name: string; detail?: string }>;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // A deliberately minimal origin: it answers /health and /version the way a
  // healthy deploy does. Other probes are left to fail, which is fine — the
  // assertions below are about ONE named check and about the exit code tracking
  // the overall result, not about staging a fully passing deployment.
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/health' || url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          version: '0.1.0',
          git_sha: DEPLOYED_SHA,
          started_at: new Date(0).toISOString(),
          driver: DEPLOYED_DRIVER,
          agent_execution: DEPLOYED_AGENT_EXECUTION,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Run the verifier and return its exit code plus its --json report. */
async function runVerifier(expectedSha: string): Promise<{ code: number; report: VerifyReport }> {
  const child = spawn(
    process.execPath,
    [SCRIPT, '--base-url', baseUrl, '--expected-sha', expectedSha, '--json'],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', () => undefined);
  const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? -1)));
  const start = stdout.indexOf('{');
  return { code, report: JSON.parse(stdout.slice(start)) as VerifyReport };
}

const SHA_CHECK = '/version git_sha matches --expected-sha';
const POSTURE_CHECK_PREFIX = '/version execution posture matches';

/** Run the verifier with the #21 posture flags and return its --json report. */
async function runVerifierWithPosture(
  driver: string,
  agentExecution: string,
): Promise<{ code: number; report: VerifyReport }> {
  const child = spawn(
    process.execPath,
    [
      SCRIPT,
      '--base-url',
      baseUrl,
      '--expected-driver',
      driver,
      '--expected-agent-execution',
      agentExecution,
      '--json',
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', () => undefined);
  const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? -1)));
  const start = stdout.indexOf('{');
  return { code, report: JSON.parse(stdout.slice(start)) as VerifyReport };
}

describe('post-deploy-verify exit contract (the auto-revert trigger)', () => {
  it('CRITICAL the sha check PASSES when the deployed git_sha matches, so the gate is not simply always-red', async () => {
    const { report } = await runVerifier(DEPLOYED_SHA);
    const sha = report.checks.find((c) => c.name === SHA_CHECK);
    expect(sha, 'the sha check ran').toBeDefined();
    expect(sha?.ok, 'a matching sha must pass').toBe(true);
  }, 60_000);

  it('CRITICAL the sha check FAILS when the origin serves a different build — the one failure a deploy cannot self-detect, since every other endpoint looks healthy while serving the previous artifact', async () => {
    const { report } = await runVerifier('deadbee');
    const sha = report.checks.find((c) => c.name === SHA_CHECK);
    expect(sha?.ok, 'a mismatched sha must fail').toBe(false);
    expect(sha?.detail ?? '', 'the detail names both shas so an operator can act').toContain(
      DEPLOYED_SHA,
    );
  }, 60_000);

  it('CRITICAL the exit code tracks the overall result. deploy-bridge.sh reads ONLY this, so an exit that stopped following the checks would leave a failed verify looking like a success and auto-revert would never fire.', async () => {
    const matched = await runVerifier(DEPLOYED_SHA);
    const mismatched = await runVerifier('deadbee');

    // Asserted as a correspondence rather than a fixed number, because the
    // fixture origin deliberately does not satisfy every probe: what must hold
    // is that exit 0 happens if and only if the report says ok.
    expect(matched.code === 0, 'exit 0 iff report.ok').toBe(matched.report.ok);
    expect(mismatched.code === 0, 'exit 0 iff report.ok').toBe(mismatched.report.ok);

    // And the mismatch case must actually be a failure, or the correspondence
    // above is satisfied by a run that never fails at all.
    expect(mismatched.report.ok, 'a sha mismatch fails the whole verify').toBe(false);
    expect(mismatched.code, 'non-zero exit is what deploy-bridge turns into a revert').not.toBe(0);
  }, 120_000);

  it('the execution-posture check PASSES on the expected posture, so it is not simply always-red', async () => {
    const { report } = await runVerifierWithPosture(DEPLOYED_DRIVER, DEPLOYED_AGENT_EXECUTION);
    const posture = report.checks.find((c) => c.name.startsWith(POSTURE_CHECK_PREFIX));
    expect(posture, 'the posture check ran').toBeDefined();
    expect(posture?.ok, 'the deployed posture must pass').toBe(true);
  }, 60_000);

  it('CRITICAL the posture check FAILS when agent_execution drifts. A prod that reported "simulated" would serve the stub executor\'s synthetic per-intent successes, and every other probe on this list would still be green.', async () => {
    const { code, report } = await runVerifierWithPosture(DEPLOYED_DRIVER, 'simulated');
    const posture = report.checks.find((c) => c.name.startsWith(POSTURE_CHECK_PREFIX));
    expect(posture?.ok, 'a drifted agent_execution must fail').toBe(false);
    // Name both sides so the operator can act without re-querying /version.
    expect(posture?.detail ?? '', 'the detail names what was actually deployed').toContain(
      DEPLOYED_AGENT_EXECUTION,
    );
    expect(posture?.detail ?? '', 'and what was expected').toContain('simulated');
    expect(code, 'a posture drift is a non-zero exit, i.e. a revert').not.toBe(0);
  }, 60_000);

  it('the posture check is OPT-IN: absent when the flags are not passed, so every existing invocation is unchanged', async () => {
    const { report } = await runVerifier(DEPLOYED_SHA);
    expect(
      report.checks.some((c) => c.name.startsWith(POSTURE_CHECK_PREFIX)),
      'no posture flags means no posture check',
    ).toBe(false);
  }, 60_000);
});
