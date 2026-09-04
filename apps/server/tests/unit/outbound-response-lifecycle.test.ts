import { createServer, type Server } from 'node:http';
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
      statusPageBaseUrl: 'https://status.driftstack.io',
      timeoutMs: 100,
    },
    createTestLogger(),
    fetcher,
  );
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected an IPv4 test-server address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port.toString()}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('outbound response lifecycle', () => {
  it.each([200, 503])('incident broadcast cancels an unread %i response body', async (status) => {
    const tracked = trackedResponse(status);
    let signalAtCancel: AbortSignal | undefined;
    let redirectAtFetch: RequestInit['redirect'];
    const service = incidentService((_url, init) => {
      signalAtCancel = init.signal ?? undefined;
      redirectAtFetch = init.redirect;
      return Promise.resolve(tracked.response);
    });

    await expect(service.notifyCreated(INCIDENT, UPDATE)).resolves.toBeUndefined();

    expect(tracked.wasCancelled()).toBe(true);
    expect(signalAtCancel?.aborted).toBe(false);
    expect(redirectAtFetch).toBe('error');
  });

  it('does not replay an incident payload through a real HTTP 307 redirect', async () => {
    let destinationHits = 0;
    let sourceHits = 0;
    let sourceBody = '';
    const destination = createServer((request, response) => {
      destinationHits += 1;
      request.resume();
      response.writeHead(204).end();
    });
    const destinationOrigin = await listen(destination);
    const source = createServer((request, response) => {
      sourceHits += 1;
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        sourceBody += chunk;
      });
      request.on('end', () => {
        response.writeHead(307, { location: `${destinationOrigin}/sink` }).end();
      });
    });
    const sourceOrigin = await listen(source);

    try {
      const service = new IncidentBroadcastService(
        {
          genericWebhookUrl: `${sourceOrigin}/redirect`,
          statusPageBaseUrl: 'https://status.driftstack.io',
          timeoutMs: 1_000,
        },
        createTestLogger(),
      );

      await expect(service.notifyCreated(INCIDENT, UPDATE)).resolves.toBeUndefined();

      expect(sourceHits).toBe(1);
      expect(sourceBody).toContain(INCIDENT.id);
      expect(destinationHits).toBe(0);
    } finally {
      await close(source);
      await close(destination);
    }
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
    let redirectAtFetch: RequestInit['redirect'];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        signalAtCancel = init?.signal ?? undefined;
        redirectAtFetch = init?.redirect;
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
    expect(redirectAtFetch).toBe('error');
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
