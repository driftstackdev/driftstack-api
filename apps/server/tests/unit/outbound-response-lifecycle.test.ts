import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { FetchProber } from '../../src/services/health-probe.js';
import { IncidentBroadcastService } from '../../src/services/incident-broadcast.js';
import type { IncidentRow, IncidentUpdateRow } from '../../src/services/incidents.js';

const NOW = new Date('2026-07-13T14:58:00Z');
const INCIDENT: IncidentRow = {
  id: 'incident-response-lifecycle',
  title: 'API health degraded',
  description: 'Investigating.',
  severity: 'major',
  status: 'investigating',
  affectedComponents: ['api'],
  public: true,
  startedAt: NOW,
  resolvedAt: null,
  createdByAdminId: null,
  createdByAdminKeyId: null,
  autoProbeTarget: 'api',
  createdAt: NOW,
  updatedAt: NOW,
};
const UPDATE: IncidentUpdateRow = {
  id: 'update-response-lifecycle',
  incidentId: INCIDENT.id,
  message: 'Investigating.',
  status: 'investigating',
  postedByAdminId: null,
  postedByAdminKeyId: null,
  postedAt: NOW,
};

function trackedResponse(
  status: number,
  rejectCancellation = false,
): {
  response: Response;
  wasCancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    // Headers arrive, but the body intentionally never produces data or
    // closes. The caller must cancel it instead of waiting for completion.
    cancel() {
      cancelled = true;
      if (rejectCancellation) throw new Error('cleanup failed');
    },
  });
  return {
    response: new Response(body, { status }),
    wasCancelled: () => cancelled,
  };
}

function incidentService(fetcher: (input: string, init: RequestInit) => Promise<Response>) {
  return new IncidentBroadcastService(
    {
      slackWebhookUrl: 'https://hooks.slack.test/services/redacted',
      statusPageBaseUrl: 'https://status.driftstack.dev',
      timeoutMs: 100,
    },
    createTestLogger(),
    fetcher,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('outbound response lifecycle', () => {
  it.each([200, 503])('incident broadcast cancels an unread %i response body', async (status) => {
    const tracked = trackedResponse(status);
    let signalAtCancel: AbortSignal | undefined;
    const service = incidentService((_url, init) => {
      signalAtCancel = init.signal ?? undefined;
      return Promise.resolve(tracked.response);
    });

    await expect(service.notifyCreated(INCIDENT, UPDATE)).resolves.toBeUndefined();

    expect(tracked.wasCancelled()).toBe(true);
    expect(signalAtCancel?.aborted).toBe(false);
  });

  it('incident broadcast preserves fire-and-forget semantics when cancellation fails', async () => {
    const tracked = trackedResponse(200, true);
    const service = incidentService(() => Promise.resolve(tracked.response));

    await expect(service.notifyCreated(INCIDENT, UPDATE)).resolves.toBeUndefined();
    expect(tracked.wasCancelled()).toBe(true);
  });

  it.each([
    [200, true],
    [503, false],
  ] as const)('health probe cancels an unread %i response body', async (status, expectedOk) => {
    const tracked = trackedResponse(status);
    let signalAtCancel: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        signalAtCancel = init?.signal ?? undefined;
        return Promise.resolve(tracked.response);
      }),
    );

    const result = await new FetchProber().probe({
      id: 'api',
      label: 'API',
      url: 'https://api.driftstack.dev/health',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ ok: expectedOk, httpStatus: status });
    expect(tracked.wasCancelled()).toBe(true);
    expect(signalAtCancel?.aborted).toBe(false);
  });

  it('health probe preserves the observed status when cancellation fails', async () => {
    const tracked = trackedResponse(200, true);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(tracked.response)),
    );

    await expect(
      new FetchProber().probe({
        id: 'api',
        label: 'API',
        url: 'https://api.driftstack.dev/health',
      }),
    ).resolves.toMatchObject({ ok: true, httpStatus: 200, errorMessage: null });
    expect(tracked.wasCancelled()).toBe(true);
  });
});
