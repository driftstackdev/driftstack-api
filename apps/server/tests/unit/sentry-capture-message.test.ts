// SentryClient.captureMessage — the channel the AI turn health watchdog alerts
// through.
//
// Run against the REAL @sentry/node pipeline (scopes, event processors, the
// V-494 scrubber), with only `init` wrapped so the finished event is captured
// at `beforeSend` and dropped instead of posted. A mocked SDK would prove the
// wrapper calls a function; it could not prove what the event that leaves the
// process contains, and that is the property that matters: an alert from a
// background job must carry only what the caller passed, not the URL of
// whatever request last left a breadcrumb in scope.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent, EventHint, NodeOptions } from '@sentry/node';
import type * as SentryModule from '@sentry/node';

const captured: ErrorEvent[] = [];

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof SentryModule>();
  return {
    ...actual,
    init: (options: NodeOptions) =>
      actual.init({
        ...options,
        // Nothing here needs the default integrations, and they would patch
        // the test process's globals — except requestData, the one that turns
        // the request a live server leaves on the isolation scope into
        // `event.request`, which is what captureMessage must strip.
        defaultIntegrations: false,
        integrations: [actual.requestDataIntegration()],
        beforeSend: (event: ErrorEvent, hint: EventHint) => {
          const scrubbed = options.beforeSend?.(event, hint) ?? event;
          captured.push(scrubbed as ErrorEvent);
          return null;
        },
      }),
  };
});

import * as Sentry from '@sentry/node';
import { initSentry, type SentryMessage } from '../../src/lib/sentry.js';
import type { Logger } from '../../src/lib/logger.js';

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
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
  } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

const logger = makeLogger();
const sentry = initSentry({
  config: {
    dsn: 'https://public@o0.ingest.de.sentry.io/0',
    environment: 'test',
    tracesSampleRate: 0,
  },
  logger,
});

const MESSAGE: SentryMessage = {
  message: 'AI turns: AgentTurnCompletionRateLow breach',
  level: 'warning',
  fingerprint: ['agent-turn-health', 'completion_rate_low'],
  tags: { component: 'agent-turn-health', condition: 'completion_rate_low', transition: 'breach' },
  extra: { samples: 12, value: 0.25, threshold: 0.5 },
};

async function nextEvent(): Promise<ErrorEvent> {
  await vi.waitFor(() => {
    expect(captured.length).toBeGreaterThan(0);
  });
  return captured.shift()!;
}

beforeEach(() => {
  captured.length = 0;
});

afterAll(async () => {
  await Sentry.close(100);
});

describe('SentryClient.captureMessage', () => {
  it('the precondition: this is the real, initialised SDK', () => {
    expect(sentry.isInitialized).toBe(true);
  });

  it('CRITICAL sends the fingerprint, level, tags and extra exactly as given — the fingerprint is what makes repeated breaches ONE issue', async () => {
    sentry.captureMessage(MESSAGE);
    const event = await nextEvent();
    expect(event.message).toBe(MESSAGE.message);
    expect(event.level).toBe('warning');
    expect(event.fingerprint).toEqual(['agent-turn-health', 'completion_rate_low']);
    expect(event.tags).toMatchObject(MESSAGE.tags!);
    expect(event.extra).toEqual(MESSAGE.extra);
  });

  it('CRITICAL strips the ambient breadcrumb trail, request and user: a background alert must not inherit the URL of whatever request ran last', async () => {
    // What the request hooks leave in scope on a live server.
    Sentry.addBreadcrumb({
      category: 'http.request',
      message: 'POST /v1/agent-sessions/as_SENTINEL_SESSION/message',
      data: { url: 'https://api.example/v1/agent-sessions/as_SENTINEL_SESSION/message' },
    });
    Sentry.getIsolationScope().setUser({ id: 'acct_SENTINEL_ACCOUNT' });
    Sentry.getCurrentScope().setUser({ id: 'acct_SENTINEL_ACCOUNT' });
    // What the http integration records for the request in flight.
    Sentry.getIsolationScope().setSDKProcessingMetadata({
      normalizedRequest: {
        method: 'POST',
        url: 'https://api.example/v1/agent-sessions/as_SENTINEL_REQUEST/message',
      },
    });
    try {
      // Positive control: an ordinary exception DOES carry them, so their
      // absence below is the processor's doing, not an empty scope.
      sentry.captureException(new Error('control'));
      const control = await nextEvent();
      expect(JSON.stringify(control)).toContain('SENTINEL');
      expect(control.request?.url).toContain('as_SENTINEL_REQUEST');

      sentry.captureMessage(MESSAGE);
      const event = await nextEvent();
      // sdkProcessingMetadata is the SDK's in-process scratch space (it holds
      // the raw request the requestData integration reads) and is deleted
      // before the envelope is built (@sentry/core envelope.js); everything
      // else here is what would be posted.
      const { sdkProcessingMetadata: _internal, ...posted } = event;
      expect(JSON.stringify(posted)).not.toContain('SENTINEL');
      expect(event.breadcrumbs ?? []).toEqual([]);
      expect(event.user).toBeUndefined();
      expect(event.request).toBeUndefined();
    } finally {
      Sentry.getIsolationScope().clear();
      Sentry.getCurrentScope().clear();
    }
  });

  it('the stripping is scoped to that one event: the next exception still carries its breadcrumbs', async () => {
    Sentry.addBreadcrumb({ category: 'auth', message: 'crumb-after' });
    try {
      sentry.captureMessage(MESSAGE);
      await nextEvent();
      sentry.captureException(new Error('later'));
      const later = await nextEvent();
      expect(JSON.stringify(later.breadcrumbs)).toContain('crumb-after');
    } finally {
      Sentry.getIsolationScope().clear();
      Sentry.getCurrentScope().clear();
    }
  });

  it('never throws: an SDK failure is logged and swallowed, as captureException is', () => {
    const spy = vi.spyOn(Sentry, 'withScope').mockImplementationOnce(() => {
      throw new Error('sdk exploded');
    });
    try {
      expect(() => {
        sentry.captureMessage(MESSAGE);
      }).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'sentry' }),
        'Sentry captureMessage failed (fire-and-forget)',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('is a no-op on the unconfigured client (dev, tests), which is why callers also log', () => {
    const quiet = initSentry({ config: null, logger: makeLogger() });
    expect(quiet.isInitialized).toBe(false);
    expect(() => {
      quiet.captureMessage(MESSAGE);
    }).not.toThrow();
  });
});
