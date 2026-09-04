// V-553.B-30 — unit tests for IncidentBroadcastService.
//
// Surface under test:
//   - no channels configured → no HTTP calls fire
//   - Slack-only / generic-only routing is independent
//   - both channels fire in parallel
//   - severity → emoji + color mapping (outage / major / minor)
//   - resolved-kind overrides the status emoji + color
//   - non-2xx HTTP response is logged at warn (does NOT throw)
//   - fetch rejection (network failure) is logged at warn (does NOT throw)
//   - timeoutMs triggers AbortController + logs warn
//   - statusPageBaseUrl trailing-slash stripping
//
// All HTTP I/O is replaced by a Fetcher seam; no real network in the
// unit suite.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IncidentBroadcastService,
  type BroadcastChannelsConfig,
  type Fetcher,
} from '../../src/services/incident-broadcast.js';
import type { IncidentRow, IncidentUpdateRow } from '../../src/services/incidents.js';
import type { Logger } from '../../src/lib/logger.js';

function makeLogger(): { logger: Logger; warns: Array<{ obj: unknown; msg: string }> } {
  const warns: Array<{ obj: unknown; msg: string }> = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (obj: unknown, msg: string) => warns.push({ obj, msg }),
    error: () => undefined,
  } as unknown as Logger;
  return { logger, warns };
}

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response;
}
function badResponse(status = 500): Response {
  return { ok: false, status } as unknown as Response;
}

function makeIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'a1b2',
    title: 'API latency elevated',
    description: 'Investigating',
    severity: 'major',
    status: 'investigating',
    affectedComponents: ['api'],
    public: true,
    startedAt: new Date('2026-05-11T10:00:00.000Z'),
    resolvedAt: null,
    createdByAdminId: null,
    createdByAdminKeyId: null,
    autoProbeTarget: null,
    createdAt: new Date('2026-05-11T10:00:00.000Z'),
    updatedAt: new Date('2026-05-11T10:00:00.000Z'),
    ...overrides,
  };
}

function makeUpdate(overrides: Partial<IncidentUpdateRow> = {}): IncidentUpdateRow {
  return {
    id: 'u1',
    incidentId: 'a1b2',
    message: 'We are investigating elevated p95 latency.',
    status: 'investigating',
    postedByAdminId: null,
    postedByAdminKeyId: null,
    postedAt: new Date('2026-05-11T10:00:30.000Z'),
    ...overrides,
  };
}

function makeBaseConfig(overrides: Partial<BroadcastChannelsConfig> = {}): BroadcastChannelsConfig {
  return {
    statusPageBaseUrl: 'https://status.driftstack.io/',
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('V-553.B-30 IncidentBroadcastService.notifyCreated/Resolved', () => {
  let fetcher: ReturnType<typeof vi.fn<Fetcher>>;

  beforeEach(() => {
    fetcher = vi.fn<Fetcher>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call fetch when no channels are configured', async () => {
    const { logger } = makeLogger();
    const svc = new IncidentBroadcastService(makeBaseConfig(), logger, fetcher);
    await svc.notifyCreated(makeIncident(), makeUpdate());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends a Slack payload when only the slack channel is configured', async () => {
    const { logger } = makeLogger();
    fetcher.mockResolvedValue(okResponse());
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' }),
      logger,
      fetcher,
    );
    await svc.notifyCreated(makeIncident(), makeUpdate());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(init.body as string) as {
      text: string;
      attachments: Array<{ color: string; fields: Array<{ title: string; value: string }> }>;
    };
    expect(body.text).toContain('Posted incident');
    expect(body.text).toContain('API latency elevated');
    // Major severity → red colour, warning emoji.
    expect(body.attachments[0]?.color).toBe('#f85149');
    expect(body.text).toContain(':warning:');
    const fields = body.attachments[0]?.fields ?? [];
    expect(fields.find((f) => f.title === 'Severity')?.value).toBe('major');
  });

  it('sends a generic JSON envelope when only the generic channel is configured', async () => {
    const { logger } = makeLogger();
    fetcher.mockResolvedValue(okResponse());
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ genericWebhookUrl: 'https://relay.example/hook' }),
      logger,
      fetcher,
    );
    await svc.notifyCreated(makeIncident(), makeUpdate());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      event: string;
      incident: { id: string; status_page_url: string; affected_components: string[] };
      update: { message: string };
    };
    expect(body.event).toBe('incident.created');
    expect(body.incident.id).toBe('inc_a1b2');
    expect(body.incident.affected_components).toEqual(['api']);
    expect(body.update.message).toBe('We are investigating elevated p95 latency.');
    // Trailing slash should be stripped from the base URL.
    expect(body.incident.status_page_url).toBe('https://status.driftstack.io');
  });

  it('fires both channels in parallel when both are configured', async () => {
    const { logger } = makeLogger();
    fetcher.mockResolvedValue(okResponse());
    const svc = new IncidentBroadcastService(
      makeBaseConfig({
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        genericWebhookUrl: 'https://relay.example/hook',
      }),
      logger,
      fetcher,
    );
    await svc.notifyCreated(makeIncident(), makeUpdate());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const urls = (fetcher.mock.calls as Array<[string, RequestInit]>).map((c) => c[0]).sort();
    expect(urls).toEqual(['https://hooks.slack.com/services/T/B/X', 'https://relay.example/hook']);
  });

  it('marks the Slack payload with resolved colour + check emoji on notifyResolved', async () => {
    const { logger } = makeLogger();
    fetcher.mockResolvedValue(okResponse());
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' }),
      logger,
      fetcher,
    );
    await svc.notifyResolved(
      makeIncident({ status: 'resolved', resolvedAt: new Date('2026-05-11T11:00:00.000Z') }),
      makeUpdate({ status: 'resolved', message: 'All clear.' }),
    );
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      text: string;
      attachments: Array<{ color: string }>;
    };
    expect(body.text).toContain('Resolved incident');
    expect(body.text).toContain(':white_check_mark:');
    expect(body.attachments[0]?.color).toBe('#2ea44f');
  });

  it('emits incident.resolved event on the generic channel for notifyResolved', async () => {
    const { logger } = makeLogger();
    fetcher.mockResolvedValue(okResponse());
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ genericWebhookUrl: 'https://relay.example/hook' }),
      logger,
      fetcher,
    );
    await svc.notifyResolved(
      makeIncident({
        status: 'resolved',
        resolvedAt: new Date('2026-05-11T11:00:00.000Z'),
      }),
      makeUpdate({ status: 'resolved' }),
    );
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      event: string;
      incident: { resolved_at: string | null };
    };
    expect(body.event).toBe('incident.resolved');
    expect(body.incident.resolved_at).toBe('2026-05-11T11:00:00.000Z');
  });

  it('maps severity=outage to red colour + red_circle emoji', async () => {
    const { logger } = makeLogger();
    fetcher.mockResolvedValue(okResponse());
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' }),
      logger,
      fetcher,
    );
    await svc.notifyCreated(makeIncident({ severity: 'outage' }), makeUpdate());
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      text: string;
      attachments: Array<{ color: string }>;
    };
    expect(body.text).toContain(':red_circle:');
    expect(body.attachments[0]?.color).toBe('#d73a4a');
  });

  it('maps severity=minor to yellow colour + info emoji', async () => {
    const { logger } = makeLogger();
    fetcher.mockResolvedValue(okResponse());
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' }),
      logger,
      fetcher,
    );
    await svc.notifyCreated(makeIncident({ severity: 'minor' }), makeUpdate());
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      text: string;
      attachments: Array<{ color: string }>;
    };
    expect(body.text).toContain(':information_source:');
    expect(body.attachments[0]?.color).toBe('#daaa3f');
  });

  it('logs warn on a non-2xx response but does not throw', async () => {
    const { logger, warns } = makeLogger();
    fetcher.mockResolvedValue(badResponse(503));
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ genericWebhookUrl: 'https://relay.example/hook' }),
      logger,
      fetcher,
    );
    await expect(svc.notifyCreated(makeIncident(), makeUpdate())).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain('non-2xx');
  });

  it('logs warn when fetch rejects and does not throw', async () => {
    const { logger, warns } = makeLogger();
    fetcher.mockRejectedValue(new Error('econnrefused'));
    const svc = new IncidentBroadcastService(
      makeBaseConfig({ slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' }),
      logger,
      fetcher,
    );
    await expect(svc.notifyCreated(makeIncident(), makeUpdate())).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain('broadcast webhook failed');
    const obj = warns[0]?.obj as { err: { message: string } };
    expect(obj.err.message).toBe('econnrefused');
  });

  it('aborts the request when timeoutMs elapses and logs warn', async () => {
    vi.useFakeTimers();
    const { logger, warns } = makeLogger();
    // Fetcher resolves only when the abort signal fires.
    fetcher.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const sig = init.signal;
        const onAbort = (): void => {
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener('abort', onAbort);
        }
      });
    });
    const svc = new IncidentBroadcastService(
      makeBaseConfig({
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
        timeoutMs: 200,
      }),
      logger,
      fetcher,
    );
    const p = svc.notifyCreated(makeIncident(), makeUpdate());
    vi.advanceTimersByTime(300);
    await p;
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain('broadcast webhook failed');
  });
});
