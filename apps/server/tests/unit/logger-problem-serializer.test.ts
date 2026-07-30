import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import pino, { type Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { BadRequestError, DriverError, FeatureUnavailableError } from '../../src/lib/errors.js';
import { redactErrSerializer, redactProblemSerializer } from '../../src/lib/logger.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

const RAW_MARKER = 'SYNTHETIC_PROBLEM_LOG_SECRET';
const RAW_URL = `https://user:pass@upstream.invalid/path?ds_token=${RAW_MARKER}&keep=ok`;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function captureLogger(): { logger: Logger; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.length > 0) records.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const logger = pino(
    {
      level: 'debug',
      base: null,
      timestamp: false,
      formatters: { level: (label) => ({ level: label }) },
      serializers: {
        err: redactErrSerializer,
        problem: redactProblemSerializer,
      },
    },
    stream,
  );
  return { logger, records };
}

describe('redactProblemSerializer', () => {
  it('scrubs URL userinfo/query credentials and keyed extensions while preserving public fields', () => {
    const out = redactProblemSerializer({
      type: 'https://errors.driftstack.dev/driver-error',
      title: 'Driver error',
      status: 502,
      detail: `upstream failed at ${RAW_URL}`,
      nested: { url: RAW_URL, benign: 'diagnostic-kept' },
      ds_token: 'raw-snake-token',
      dsToken: 'raw-camel-token',
      attempt: 7,
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(out);

    for (const secret of [RAW_MARKER, 'user:pass', 'raw-snake-token', 'raw-camel-token']) {
      expect(serialized).not.toContain(secret);
    }
    expect(out).toMatchObject({
      type: 'https://errors.driftstack.dev/driver-error',
      title: 'Driver error',
      status: 502,
      ds_token: '[redacted]',
      dsToken: '[redacted]',
      attempt: 7,
    });
    expect(serialized).toContain('ds_token=[redacted]');
    expect(serialized).toContain('diagnostic-kept');
  });

  it('is byte-equivalent for a credential-free problem', () => {
    const clean = {
      type: 'https://errors.driftstack.dev/bad-request',
      title: 'Bad Request',
      status: 400,
      detail: 'The label is required.',
      instance: 'req_clean',
      issues: [{ path: 'label', code: 'required' }],
    };

    expect(JSON.stringify(redactProblemSerializer(clean))).toBe(JSON.stringify(clean));
  });

  it('fails closed on over-depth and cyclic problem extensions', () => {
    let deep: Record<string, unknown> = { detail: RAW_URL };
    for (let depth = 0; depth < 10; depth += 1) deep = { nested: deep };
    const cycle: Record<string, unknown> = { authorization: `Bearer ${RAW_MARKER}` };
    cycle.self = cycle;

    const serialized = JSON.stringify(
      redactProblemSerializer({ type: 'safe', title: 'safe', status: 500, deep, cycle }),
    );
    expect(serialized).not.toContain(RAW_MARKER);
    expect(serialized).toContain('[redacted: structure limit]');
  });

  it('is inherited by request child loggers and retains correlation/diagnostic fields', () => {
    const { logger, records } = captureLogger();
    logger.child({ reqId: 'req_child' }).warn(
      {
        problem: {
          type: 'https://errors.driftstack.dev/driver-error',
          title: 'Driver error',
          status: 502,
          detail: RAW_URL,
          benign: 'kept',
        },
      },
      'request rejected',
    );

    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain(RAW_MARKER);
    expect(serialized).not.toContain('user:pass');
    expect(records[0]).toMatchObject({ reqId: 'req_child', level: 'warn' });
    expect(records[0]?.problem).toMatchObject({
      type: 'https://errors.driftstack.dev/driver-error',
      title: 'Driver error',
      status: 502,
      benign: 'kept',
    });
  });

  it.each([
    {
      path: '/bad-request',
      status: 400,
      level: 'warn',
      makeError: () =>
        new BadRequestError(`invalid callback ${RAW_URL}`, { url: RAW_URL, keep: 1 }),
    },
    {
      path: '/driver-error',
      status: 502,
      level: 'error',
      makeError: () => new DriverError(`driver rejected ${RAW_URL}`, { url: RAW_URL, keep: 2 }),
    },
    {
      path: '/unavailable',
      status: 503,
      level: 'warn',
      makeError: () => new FeatureUnavailableError(`deployment unavailable at ${RAW_URL}`),
    },
  ])(
    'scrubs the $status log problem while preserving the exact customer response',
    async ({ path, status, level, makeError }) => {
      const { logger, records } = captureLogger();
      const loggerInstance: FastifyBaseLogger = logger;
      const app = Fastify({ loggerInstance });
      registerErrorHandler(app);
      app.get(path, () => {
        throw makeError();
      });

      try {
        const response = await app.inject({ method: 'GET', url: path });
        expect(response.statusCode).toBe(status);
        const body = response.json<Record<string, unknown>>();
        expect(body.status).toBe(status);
        expect(body.detail).toContain(RAW_MARKER);
        expect(body.detail).toContain('user:pass');
        expect(typeof body.instance).toBe('string');
        if (status !== 503) {
          expect(body.url).toBe(RAW_URL);
          expect(body.keep).toBe(status === 400 ? 1 : 2);
        }

        const record = records.find((candidate) => candidate.problem !== undefined);
        expect(record).toBeDefined();
        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain(RAW_MARKER);
        expect(serialized).not.toContain('user:pass');
        expect(record).toMatchObject({ level });
        expect(record?.problem).toMatchObject({ status });
        expect(record?.err).toBeDefined();
      } finally {
        await app.close();
      }
    },
  );

  it('pins every runtime producer to the centralized top-level problem serializer', () => {
    const errorHandler = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'),
      'utf8',
    );
    const agentSessions = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts'),
      'utf8',
    );

    expect(errorHandler.match(/\{ err, problem: apiError\.toProblem\(\) \}/g)).toHaveLength(3);
    expect(agentSessions.match(/\{ err: error, problem: body \}/g)).toHaveLength(2);
  });
});
