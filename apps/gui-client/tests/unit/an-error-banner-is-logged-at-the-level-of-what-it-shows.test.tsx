// Item 8 follow-up, 2026-09-24: ErrorBanner logged EVERY banner at ERROR,
// including ordinary, handled answers — a name already taken, a validation
// refusal. That buried the real failures in the developer log. A banner that
// follows a 4xx the server answered is a WARN; a 5xx, no answer, or a failure
// that did not come from a request stays ERROR.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ErrorBanner, bannerLogLevel } from '../../src/components/ErrorBanner';
import {
  buildClient,
  RECENT_API_FAILURE_MS,
  resetApiReachabilityForTests,
} from '../../src/lib/client';
import { clearLogEntries, getLogEntries } from '../../src/lib/log-buffer';

function problem(status: number): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, detail: 'x' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

async function afterAnswer(status: number): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(problem(status))),
  );
  const client = buildClient('ds_live_test_key', 'https://api.example.com');
  await client?.profiles.create({ name: 'x' }).catch(() => undefined);
}

function bannerLevel(): string | undefined {
  return getLogEntries().find((e) => e.text.startsWith('[ui] '))?.level;
}

beforeEach(() => {
  resetApiReachabilityForTests();
  clearLogEntries();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('an error banner is logged at the level of what it shows', () => {
  it('CRITICAL a banner after a 409 the server answered is a WARN', async () => {
    await afterAnswer(409);
    render(<ErrorBanner message="That name is already taken." onDismiss={() => undefined} />);
    expect(bannerLevel()).toBe('warn');
  });

  it('a banner after a 422 validation refusal is a WARN', async () => {
    await afterAnswer(422);
    render(<ErrorBanner message="Check the details and try again." onDismiss={() => undefined} />);
    expect(bannerLevel()).toBe('warn');
  });

  it('CRITICAL a banner after a 500 is still an ERROR', async () => {
    await afterAnswer(500);
    render(<ErrorBanner message="Couldn't save this proxy." onDismiss={() => undefined} />);
    expect(bannerLevel()).toBe('error');
  });

  it('a banner with no failed request behind it (a local failure) is still an ERROR', () => {
    render(<ErrorBanner message="Couldn't read the saved proxies." onDismiss={() => undefined} />);
    expect(bannerLevel()).toBe('error');
  });

  it('a 4xx from long before does not explain a banner now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    return (async () => {
      await afterAnswer(409);
      vi.setSystemTime(new Date(Date.now() + RECENT_API_FAILURE_MS + 1_000));
      render(<ErrorBanner message="Something failed." onDismiss={() => undefined} />);
      expect(bannerLevel()).toBe('error');
    })();
  });

  it('a caller that knows better says so', () => {
    render(<ErrorBanner message="Enter a name." onDismiss={() => undefined} logLevel="warn" />);
    expect(bannerLevel()).toBe('warn');
  });

  it('the rule itself: only an answered 4xx is a WARN', () => {
    expect(bannerLogLevel({ status: 404 })).toBe('warn');
    expect(bannerLogLevel({ status: 503 })).toBe('error');
    expect(bannerLogLevel({ status: 0 })).toBe('error');
    expect(bannerLogLevel(null)).toBe('error');
  });
});
