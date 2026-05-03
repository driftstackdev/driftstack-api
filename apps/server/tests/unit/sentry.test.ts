// Sentry init helper tests.
//
// We don't actually post to Sentry; we mock @sentry/node and verify
// the wrapper's behaviour: no-op when unconfigured, real init call
// when configured, captureException swallow-on-error, and the EU
// DSN region requirement enforced at config-parse time.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(true),
}));

import * as Sentry from '@sentry/node';
import { initSentry, wireSentryErrorHandler } from '../../src/lib/sentry.js';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryClient } from '../../src/lib/sentry.js';
import { loadConfig } from '../../src/lib/config.js';

function makeLogger(): Logger {
  const fns = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  return {
    ...fns,
    level: 'info',
    silent: () => {},
    child: () => makeLogger(),
  } as unknown as Logger;
}

beforeEach(() => {
  vi.mocked(Sentry.init).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
});

describe('initSentry', () => {
  it('returns a no-op client when config is null', () => {
    const logger = makeLogger();
    const sentry = initSentry({ config: null, logger });
    expect(sentry.isInitialized).toBe(false);
    sentry.captureException(new Error('test'));
    expect(Sentry.init).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('initializes the SDK with DSN, environment, release, tracesSampleRate', () => {
    const logger = makeLogger();
    const sentry = initSentry({
      config: {
        dsn: 'https://abc@o123.ingest.de.sentry.io/456',
        environment: 'production',
        release: 'v1.2.3',
        tracesSampleRate: 0.1,
      },
      logger,
    });
    expect(sentry.isInitialized).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith({
      dsn: 'https://abc@o123.ingest.de.sentry.io/456',
      environment: 'production',
      release: 'v1.2.3',
      tracesSampleRate: 0.1,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'sentry', environment: 'production' }),
      'Sentry initialized',
    );
  });

  it('omits release when undefined', () => {
    const logger = makeLogger();
    initSentry({
      config: {
        dsn: 'https://abc@o123.ingest.de.sentry.io/456',
        environment: 'staging',
        tracesSampleRate: 0,
      },
      logger,
    });
    const call = vi.mocked(Sentry.init).mock.calls[0]![0]!;
    expect('release' in call).toBe(false);
  });

  it('captureException forwards to SDK with extra context', () => {
    const logger = makeLogger();
    const sentry = initSentry({
      config: {
        dsn: 'https://abc@o123.ingest.de.sentry.io/456',
        environment: 'production',
        tracesSampleRate: 0,
      },
      logger,
    });
    const err = new Error('boom');
    sentry.captureException(err, { request_id: 'req_abc' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      extra: { request_id: 'req_abc' },
    });
  });

  it('captureException swallows SDK errors and logs warn', () => {
    const logger = makeLogger();
    const sentry = initSentry({
      config: {
        dsn: 'https://abc@o123.ingest.de.sentry.io/456',
        environment: 'production',
        tracesSampleRate: 0,
      },
      logger,
    });
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
      throw new Error('sentry SDK boom');
    });
    sentry.captureException(new Error('original'));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'sentry' }),
      expect.stringContaining('captureException failed'),
    );
  });
});

describe('config.sentry — EU region enforcement', () => {
  it('rejects a non-EU DSN', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        SENTRY_DSN: 'https://abc@o123.ingest.us.sentry.io/456',
        SENTRY_ENVIRONMENT: 'production',
      }),
    ).toThrow(/EU region/);
  });

  it('accepts an EU DSN', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      SENTRY_DSN: 'https://abc@o123.ingest.de.sentry.io/456',
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_TRACES_SAMPLE_RATE: '0.05',
    });
    expect(cfg.sentry?.dsn).toContain('.de.');
    expect(cfg.sentry?.tracesSampleRate).toBe(0.05);
  });

  it('returns sentry: null when DSN is missing', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      SENTRY_ENVIRONMENT: 'production',
    });
    expect(cfg.sentry).toBeNull();
  });
});

describe('wireSentryErrorHandler', () => {
  it('installs an onError hook that captures with request context', () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const fakeApp = {
      addHook: (name: string, fn: unknown) => {
        calls.push({ name, args: [fn] });
      },
    } as unknown as Parameters<typeof wireSentryErrorHandler>[0];

    const captured: Array<[unknown, Record<string, unknown> | undefined]> = [];
    const sentry: SentryClient = {
      isInitialized: true,
      captureException: (err, ctx) => {
        captured.push([err, ctx]);
      },
      flush: () => Promise.resolve(true),
      close: () => Promise.resolve(true),
    };

    wireSentryErrorHandler(fakeApp, sentry);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('onError');

    // Invoke the hook fn manually with a fake request + reply.
    const hook = calls[0]!.args[0] as (
      req: { id: string; method: string; url: string; routeOptions?: { url: string } },
      reply: unknown,
      err: unknown,
      done: () => void,
    ) => void;
    let doneCalled = false;
    hook(
      {
        id: 'req_abc',
        method: 'POST',
        url: '/v1/sessions',
        routeOptions: { url: '/v1/sessions' },
      },
      {},
      new Error('boom'),
      () => {
        doneCalled = true;
      },
    );
    expect(doneCalled).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]![1]).toMatchObject({
      request_id: 'req_abc',
      method: 'POST',
      url: '/v1/sessions',
      route: '/v1/sessions',
    });
  });
});
