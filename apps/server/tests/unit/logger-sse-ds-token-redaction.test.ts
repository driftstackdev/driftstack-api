// SSE ?ds_token= leak hardening — proof that the production logger's `req`
// serializer redacts the bearer token Fastify's auto request-logging would
// otherwise write into `req.url` for the EventSource auth path
// (requireAuthEventSource accepts the credential as a `?ds_token=` query
// param because EventSource can't set headers).
//
// redact-url.test.ts proves redactUrlQueryTokens() in isolation; this
// proves the exact serializer that createLogger() wires (redactReqSerializer)
// strips the credential from a logged request — so a refactor that drops it
// fails here. Decision: KEEP ds_token (migrating to a single-purpose ticket
// would break live EventSource clients in the SDK / dashboard / GUI) and
// instead guarantee the app logger + Sentry never surface the credential.
// This locks that guarantee for the log channel.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { redactReqSerializer } from '../../src/lib/logger.js';

describe('redactReqSerializer redacts the SSE ?ds_token= bearer from req.url', () => {
  it('redacts ds_token on the notifications SSE route, keeping the path', () => {
    const out = redactReqSerializer({
      method: 'GET',
      url: '/v1/account/me/notifications?ds_token=ds_live_SUPERSECRET',
    });
    expect(out.url).not.toContain('SUPERSECRET');
    expect(out.url).toContain('ds_token=');
    expect(out.url).toContain('/v1/account/me/notifications');
  });

  it('redacts ds_token on the agent-sessions transcript SSE route', () => {
    const out = redactReqSerializer({
      method: 'GET',
      url: '/v1/agent-sessions/abc/transcript?ds_token=ds_live_LEAKME',
    });
    expect(out.url).not.toContain('LEAKME');
    expect(out.url).toContain('/v1/agent-sessions/abc/transcript');
  });

  it('leaves a credential-free URL untouched', () => {
    const out = redactReqSerializer({ method: 'GET', url: '/v1/account/me?expand=usage' });
    expect(out.url).toBe('/v1/account/me?expand=usage');
  });

  it('preserves the rest of the Fastify req shape (method/host/remoteAddress/remotePort)', () => {
    const out = redactReqSerializer({
      method: 'GET',
      url: '/v1/account/me/notifications?ds_token=secret',
      host: 'api.driftstack.dev',
      ip: '203.0.113.7',
      socket: { remotePort: 54321 },
    });
    expect(out.method).toBe('GET');
    expect(out.host).toBe('api.driftstack.dev');
    expect(out.remoteAddress).toBe('203.0.113.7');
    expect(out.remotePort).toBe(54321);
  });
});

// V-1387 — the header above says this file proves the serializer `createLogger()` wires.
// It proves the serializer. It does not prove the wiring, and coverage says nothing did:
// `createLogger` is 155 lines and was never executed — every serializer it installs is
// tested directly, and `createTestLogger` is what the suite uses.
//
// The gap that leaves is specific. `redact.paths` is a 40-entry list whose own comment says
// new sensitive fields MUST be added to it, and a cross-source guard pins that list as
// SOURCE TEXT. Text is not effect: rename the `redact` key, change the option shape, or drop
// `serializers` from the pino call and every existing test stays green while production
// starts logging Authorization headers and BYOK keys in the clear.
//
// So this drives the real factory in a child process and reads what it actually writes to
// stdout. A child rather than an in-process capture because pino writes through sonic-boom
// to fd 1, which `process.stdout.write` does not intercept.
const HERE = dirname(fileURLToPath(import.meta.url));
const LOGGER_MODULE = resolve(HERE, '..', '..', 'src', 'lib', 'logger.js');
let scratch: string | undefined;

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

describe('the logger the server actually boots redacts what its path list claims', () => {
  it('CRITICAL createLogger() output carries none of the secrets it lists, marks them redacted, and keeps ordinary fields. The serializer arms above pass against a factory that never installs them; this fails if the wiring is dropped, which is the failure that reaches production silently.', () => {
    scratch = mkdtempSync(join(tmpdir(), 'driftstack-logger-'));
    const entry = join(scratch, 'probe.ts');
    writeFileSync(
      entry,
      [
        `import { createLogger } from ${JSON.stringify(LOGGER_MODULE)};`,
        `const logger = createLogger({ logLevel: 'info', nodeEnv: 'production' });`,
        'logger.info(',
        '  {',
        `    apiKey: 'ds_live_LEAK_APIKEY',`,
        `    secret: 'LEAK_SECRET',`,
        `    body: { password: 'LEAK_PASSWORD', code: 'LEAK_MFA_CODE', client_secret: 'LEAK_CLIENT_SECRET' },`,
        `    req: { method: 'GET', url: '/v1/account/me/notifications?ds_token=ds_live_LEAK_DSTOKEN', headers: { authorization: 'Bearer LEAK_BEARER' } },`,
        `    ordinary: 'KEEP_THIS_FIELD',`,
        '  },',
        `  'probe',`,
        ');',
      ].join('\n'),
    );

    const run = spawnSync('npx', ['tsx', entry], {
      cwd: resolve(HERE, '..', '..', '..', '..'),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(run.status, `the probe did not run:\n${run.stderr ?? ''}`).toBe(0);
    const line = run.stdout.trim().split('\n').at(-1) ?? '';
    expect(line, 'the probe emitted no log line').toContain('"msg":"probe"');

    for (const leak of [
      'ds_live_LEAK_APIKEY',
      'LEAK_SECRET',
      'LEAK_PASSWORD',
      'LEAK_MFA_CODE',
      'LEAK_CLIENT_SECRET',
      'LEAK_BEARER',
      // Only the req SERIALIZER strips this one — `redact.paths` does not list `req.url`,
      // so it is what separates the two halves of the wiring.
      'ds_live_LEAK_DSTOKEN',
    ]) {
      expect(line, `${leak} reached the log line`).not.toContain(leak);
    }
    // Absence alone would also be satisfied by a logger that dropped the whole payload, so
    // pin both that redaction is what happened and that an ordinary field survived it.
    expect(
      line,
      'nothing was marked redacted, so the fields were lost rather than scrubbed',
    ).toContain('[redacted]');
    expect(line, 'a non-sensitive field must still be logged').toContain('KEEP_THIS_FIELD');
  });
});
