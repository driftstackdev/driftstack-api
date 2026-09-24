// Security sweep E-1 (HIGH, 2026-09-24) — the Sentry scrubber was registered for
// error events and breadcrumbs only. With a non-zero traces sample rate every
// sampled request went to the vendor as a TRANSACTION event, and those carried
// the request exactly as it arrived: `authorization: Bearer <token>`, cookies,
// the Stripe and NowPayments signature headers, the per-session control key,
// and `?ds_token=` / OAuth `code` / `state` in the URL, the query string and the
// trace's span attributes (http.url, http.target, http.query). The error event
// from the same request had all of it redacted. (A skeptic reproduced it with the
// real initSentry against a loopback fake ingest.)
//
// Two halves, both needed: the scrubbers must redact every one of those places,
// and initSentry must actually register them for transactions and spans.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
  close: vi.fn(() => Promise.resolve(true)),
  setupFastifyErrorHandler: vi.fn(),
}));

import * as Sentry from '@sentry/node';

import {
  __test_scrubSentrySpan as scrubSentrySpan,
  __test_scrubSentryTransaction as scrubSentryTransaction,
  initSentry,
} from '../../src/lib/sentry.js';
import type { Logger } from '../../src/lib/logger.js';

// The SDK does not export these event shapes by name; take them from its own hook types.
type TransactionEvent = Parameters<NonNullable<Sentry.NodeOptions['beforeSendTransaction']>>[0];
type SpanJSON = Parameters<NonNullable<Sentry.NodeOptions['beforeSendSpan']>>[0];

const SECRETS = [
  'Bearer ds_live_SECRETKEY123',
  'session=COOKIESECRET',
  't=1,v1=STRIPESIG',
  'NOWPAYSIG',
  'GUICONTROLKEY',
  'DSTOKENSECRET',
  'OAUTHCODESECRET',
  'OAUTHSTATESECRET',
];
const QUERY = 'ds_token=DSTOKENSECRET&code=OAUTHCODESECRET&state=OAUTHSTATESECRET&page=2';

function transaction(): TransactionEvent {
  return {
    type: 'transaction',
    transaction: `GET /v1/agent-sessions/:id/stream`,
    request: {
      url: `https://api.driftstack.dev/v1/agent-sessions/x/stream?${QUERY}`,
      query_string: QUERY,
      method: 'GET',
      headers: {
        authorization: 'Bearer ds_live_SECRETKEY123',
        cookie: 'session=COOKIESECRET',
        'stripe-signature': 't=1,v1=STRIPESIG',
        'x-nowpayments-sig': 'NOWPAYSIG',
        'x-driftstack-gui-control-key': 'GUICONTROLKEY',
        'user-agent': 'curl/8',
      },
      cookies: { session: 'COOKIESECRET' },
    },
    contexts: {
      trace: {
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
        data: {
          'http.url': `https://api.driftstack.dev/v1/agent-sessions/x/stream?${QUERY}`,
          'http.target': `/v1/agent-sessions/x/stream?${QUERY}`,
          'http.query': `?${QUERY}`,
          'url.full': `https://api.driftstack.dev/v1/agent-sessions/x/stream?${QUERY}`,
          'url.query': QUERY,
          'http.request.header.stripe_signature': 't=1,v1=STRIPESIG',
          'http.request.header.x_nowpayments_sig': 'NOWPAYSIG',
          'http.method': 'GET',
        },
      },
    },
    spans: [
      {
        span_id: 'c'.repeat(16),
        trace_id: 'a'.repeat(32),
        start_timestamp: 1,
        data: {
          'http.url': `https://upstream.example/cb?${QUERY}`,
          'http.request.header.authorization': 'Bearer ds_live_SECRETKEY123',
          'http.request.header.x_driftstack_gui_control_key': 'GUICONTROLKEY',
        },
      },
    ],
  };
}

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value);
  return SECRETS.filter((s) => text.includes(s));
}

describe('a sampled trace reaches error monitoring with its secrets redacted', () => {
  it('CRITICAL a transaction event keeps none of the eight secrets — request, trace data or child spans', () => {
    const scrubbed = scrubSentryTransaction(transaction());
    expect(leaks(scrubbed)).toEqual([]);
    // What is not secret stays, so traces remain useful.
    expect(scrubbed.request?.method).toBe('GET');
    expect(scrubbed.request?.headers?.['user-agent']).toBe('curl/8');
    expect(scrubbed.contexts?.trace?.data?.['http.method']).toBe('GET');
    expect(String(scrubbed.request?.url)).toContain('page=2');
  });

  it('CRITICAL a span sent on its own keeps none of them either', () => {
    const span = {
      span_id: 'd'.repeat(16),
      trace_id: 'a'.repeat(32),
      start_timestamp: 1,
      data: { ...transaction().contexts!.trace!.data!, ...transaction().spans![0]!.data },
    } as SpanJSON;
    expect(leaks(scrubSentrySpan(span))).toEqual([]);
  });

  describe('initSentry registers them', () => {
    beforeEach(() => vi.mocked(Sentry.init).mockClear());

    it('CRITICAL Sentry.init receives beforeSendTransaction and beforeSendSpan, and they scrub', () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: () => logger,
      } as unknown as Logger;
      initSentry({
        config: {
          dsn: 'https://abc@o123.ingest.de.sentry.io/456',
          environment: 'production',
          tracesSampleRate: 0.05,
        },
        logger,
      });
      const options = vi.mocked(Sentry.init).mock.calls[0]![0]!;
      expect(options.beforeSendTransaction).toEqual(expect.any(Function));
      expect(options.beforeSendSpan).toEqual(expect.any(Function));
      const sent = options.beforeSendTransaction!(transaction(), {});
      expect(leaks(sent)).toEqual([]);
      const span = options.beforeSendSpan!(transaction().spans![0] as SpanJSON);
      expect(leaks(span)).toEqual([]);
    });
  });
});
