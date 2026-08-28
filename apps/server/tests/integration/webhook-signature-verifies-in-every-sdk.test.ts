// V-1353 — a header the SERVER signs must verify in ALL THREE published SDKs, executed.
//
// Two guards already stand near this and neither covers it:
//
//   `cross-sdk-webhook-signature-parity` compares the three SDKs by READING their source
//   and asserting they describe the same format. Its own header says why the property is
//   security-critical — three SDKs that disagree let customers "silently miss real webhooks
//   OR accept forged ones" — but a source comparison cannot see a parser that reads the
//   format correctly and applies it wrongly.
//
//   `durable-webhook-signature-sdk-verify` DOES feed a real emitted header to a verifier,
//   and closed a genuine bug that way: the durable path once signed bare hex, which the SDK
//   verifier silently rejected. It verifies with the TypeScript SDK only. Python and Go
//   customers were covered by the text comparison alone.
//
// So this drives the server's own `signWebhookPayload` and hands the result to each of the
// three verifiers as a customer's process would receive it.
//
// THE ROTATION CASE IS THE POINT. During a secret rotation the server emits
// `t=…,v1=<curr>,v1=<prev>` — two signatures in one header. A verifier that reads only the
// FIRST `v1=` accepts the current secret and silently rejects every delivery a customer is
// still verifying with the previous one, which is precisely the window rotation exists to
// make safe. Nothing had ever executed that header shape against the Python or Go parser.

import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@driftstack/sdk';
import { signWebhookPayload } from '../../src/lib/webhook-signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const PYTHON = resolve(REPO, 'packages/sdk-python/.venv/bin/python');
const GO_DIR = resolve(REPO, 'packages/sdk-go');

const SECRET = 'whsec_current_secret_for_the_signature_bridge';
const PREV = 'whsec_previous_secret_inside_the_grace_window';
const BODY = JSON.stringify({ id: 'evt_bridge', type: 'session.completed', data: { ok: true } });
/** Fixed instant: a fixture pinned to `Date.now()` rots into a replay-window failure. */
const SIGNED_AT = 1_767_225_600;
/** Inside any sane tolerance, and far enough from the boundary not to be flaky. */
const VERIFY_AT = SIGNED_AT + 5;

/** The header the control plane actually emits mid-rotation: two `v1=` entries. */
const HEADER = signWebhookPayload({
  body: BODY,
  secret: SECRET,
  secretPrev: PREV,
  timestampSec: SIGNED_AT,
});

const FIXTURE = resolve(tmpdir(), `driftstack-sig-fixture-${String(SIGNED_AT)}.json`);
writeFileSync(
  FIXTURE,
  JSON.stringify({ t: SIGNED_AT, body: BODY, secret: SECRET, prev: PREV, header: HEADER }),
);

describe('a server-signed webhook header verifies in every published SDK', () => {
  it('CRITICAL the header under test carries TWO signatures, so the rotation case is actually being exercised. A single-signature header would let every arm below pass while saying nothing about the grace window.', () => {
    expect(HEADER.match(/v1=/g) ?? [], 'the emitted header is not dual-signed').toHaveLength(2);
    expect(HEADER.startsWith(`t=${String(SIGNED_AT)},`), 'the timestamp leads the header').toBe(
      true,
    );
  });

  it('CRITICAL TypeScript accepts the current secret, accepts the previous one, and rejects a tampered body', async () => {
    const nowMs = VERIFY_AT * 1000;
    await expect(
      verifyWebhookSignature({ body: BODY, header: HEADER, secret: SECRET, nowMs }),
      'current secret',
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ body: BODY, header: HEADER, secret: PREV, nowMs }),
      'previous secret inside the grace window',
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ body: `${BODY}x`, header: HEADER, secret: SECRET, nowMs }),
      'a tampered body must not verify',
    ).resolves.toBe(false);
  });

  it('CRITICAL Python accepts both secrets and rejects a tampered body, run in the published package rather than compared as text', (ctx) => {
    // V-2128 — a silent return here read as a pass, so a local run without the venv
    // said "verified in every SDK" about an arm that never ran. Report the skip.
    if (!process.env.CI && !existsSync(PYTHON))
      ctx.skip('python venv absent locally; CI runs this arm');
    expect(existsSync(PYTHON), `python venv present at ${PYTHON}`).toBe(true);

    const script = [
      'import json,sys',
      'from driftstack.webhook_signature import verify_webhook_signature as v',
      `f=json.load(open(${JSON.stringify(FIXTURE)}))`,
      `at=f["t"]+5`,
      'cur=v(body=f["body"], header=f["header"], secret=f["secret"], now_seconds=at)',
      'prev=v(body=f["body"], header=f["header"], secret=f["prev"], now_seconds=at)',
      'tam=v(body=f["body"]+"x", header=f["header"], secret=f["secret"], now_seconds=at)',
      'print(json.dumps({"cur":cur,"prev":prev,"tam":tam}))',
    ].join('\n');

    const run = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, `python verifier failed to run:\n${run.stderr ?? ''}`).toBe(0);
    const out = JSON.parse(run.stdout.trim()) as { cur: boolean; prev: boolean; tam: boolean };
    expect(out.cur, 'current secret').toBe(true);
    expect(out.prev, 'previous secret inside the grace window').toBe(true);
    expect(out.tam, 'a tampered body must not verify').toBe(false);
  });

  // V-1354 — Go, now that the arm is trustworthy.
  //
  // A first attempt at this arm PASSED under the separator mutation while the fixture on
  // disk provably carried a bad signature, so it was removed rather than shipped. The cause
  // was `go test` result caching: the arm omitted `-count=1`, and an earlier attempt to rule
  // caching out used a DIFFERENT fixture path, which is a different cache entry — so it
  // exonerated the wrong thing. Instrumented, the spawn returns status 1 and zero
  // `--- PASS` lines exactly as it should once `-count=1` is passed.
  it('CRITICAL Go accepts both secrets and rejects a tampered body — run with -count=1, and asserted to have RUN rather than skipped. `go test` prints ok and exits 0 both for a cached result and for a package whose tests all skipped, so neither the exit code nor a bare PASS is evidence on its own.', (ctx) => {
    if (!process.env.CI && !existsSync(resolve(GO_DIR, 'go.mod')))
      ctx.skip('Go SDK module absent locally; CI runs this arm');

    const run = spawnSync(
      'go',
      ['test', '-count=1', '-run', 'TestVerifyServerEmittedSignatureFixture', '-v', './...'],
      {
        cwd: GO_DIR,
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, DS_SIG_FIXTURE: FIXTURE },
      },
    );
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    expect(
      (out.match(/^\s*--- SKIP: TestVerifyServerEmittedSignatureFixture/gm) ?? []).length,
      `the Go fixture case SKIPPED, so nothing was verified:\n${out}`,
    ).toBe(0);
    expect(
      (out.match(/^\s*--- PASS: TestVerifyServerEmittedSignatureFixture/gm) ?? []).length,
      `the Go fixture case did not pass:\n${out}`,
    ).toBe(1);
    expect(run.status, 'and go test exits clean').toBe(0);
  });
});
