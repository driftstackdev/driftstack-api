// V-295d — outbound incident broadcast service.
//
// When a public incident is created or resolved (V-295a admin path
// OR V-295b auto-poll path), this service POSTs a payload to each
// configured outbound webhook URL. Two channel formats:
//
//   - 'slack' — Slack incoming-webhook payload shape `{ text }` plus
//     an attachments block with severity / status / title / link.
//     Compatible with Slack's incoming-webhook URL out of the box.
//
//   - 'generic' — JSON envelope `{ event, incident, generated_at }`
//     for arbitrary relays (Twitter via Zapier/IFTTT/N8N, Discord
//     via webhook proxy, custom integrations). Founder bridges to
//     the destination platform.
//
// The service is dispatched from the IncidentsService lifecycle
// callbacks alongside V-295c3-followup email fan-out — both fire on
// the same lifecycle event; one channel failing does not stall the
// other.
//
// All HTTP calls are fire-and-forget: errors are logged at warn-level
// but never throw to the caller. Incident writes must never roll back
// because of a webhook delivery failure.

import type { Logger } from '../lib/logger.js';
import type { IncidentRow, IncidentUpdateRow } from './incidents.js';

export interface BroadcastChannelsConfig {
  /** Slack incoming-webhook URL (`https://hooks.slack.com/services/...`). */
  slackWebhookUrl?: string | null;
  /** Generic outbound webhook URL — JSON envelope. */
  genericWebhookUrl?: string | null;
  /** Public origin of the status site, embedded in payloads. */
  statusPageBaseUrl: string;
  /** Per-channel HTTP timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export class IncidentBroadcastService {
  private readonly slack: string | null;
  private readonly generic: string | null;
  private readonly statusPageBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(
    config: BroadcastChannelsConfig,
    private readonly logger: Logger,
    fetcher?: Fetcher,
  ) {
    this.slack = config.slackWebhookUrl ?? null;
    this.generic = config.genericWebhookUrl ?? null;
    this.statusPageBaseUrl = config.statusPageBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  async notifyCreated(incident: IncidentRow, update: IncidentUpdateRow): Promise<void> {
    await this.broadcast(incident, update, 'created');
  }

  async notifyResolved(incident: IncidentRow, update: IncidentUpdateRow): Promise<void> {
    await this.broadcast(incident, update, 'resolved');
  }

  private async broadcast(
    incident: IncidentRow,
    update: IncidentUpdateRow,
    kind: 'created' | 'resolved',
  ): Promise<void> {
    // Dispatch in parallel — channels are independent.
    await Promise.all([
      this.slack ? this.sendSlack(this.slack, incident, update, kind) : Promise.resolve(),
      this.generic ? this.sendGeneric(this.generic, incident, update, kind) : Promise.resolve(),
    ]);
  }

  private async sendSlack(
    url: string,
    incident: IncidentRow,
    update: IncidentUpdateRow,
    kind: 'created' | 'resolved',
  ): Promise<void> {
    const verb = kind === 'created' ? 'Posted' : 'Resolved';
    const severityEmoji =
      incident.severity === 'outage'
        ? ':red_circle:'
        : incident.severity === 'major'
          ? ':warning:'
          : ':information_source:';
    const statusEmoji = kind === 'resolved' ? ':white_check_mark:' : severityEmoji;
    const text = `${statusEmoji} *${verb} incident:* ${incident.title}`;
    const link = `${this.statusPageBaseUrl}`;
    const payload = {
      text,
      attachments: [
        {
          color:
            kind === 'resolved'
              ? '#2ea44f'
              : incident.severity === 'outage'
                ? '#d73a4a'
                : incident.severity === 'major'
                  ? '#f85149'
                  : '#daaa3f',
          fields: [
            { title: 'Severity', value: incident.severity, short: true },
            { title: 'Status', value: incident.status, short: true },
            { title: 'Update', value: update.message, short: false },
          ],
          actions: [{ type: 'button', text: 'View status page', url: link }],
        },
      ],
    };
    await this.post('slack', url, payload);
  }

  private async sendGeneric(
    url: string,
    incident: IncidentRow,
    update: IncidentUpdateRow,
    kind: 'created' | 'resolved',
  ): Promise<void> {
    const payload = {
      event: kind === 'created' ? 'incident.created' : 'incident.resolved',
      generated_at: new Date().toISOString(),
      incident: {
        id: `inc_${incident.id}`,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        public: incident.public,
        started_at: incident.startedAt.toISOString(),
        resolved_at: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
        affected_components: [...incident.affectedComponents],
        status_page_url: this.statusPageBaseUrl,
      },
      update: {
        message: update.message,
        status: update.status,
        posted_at: update.postedAt.toISOString(),
      },
    };
    await this.post('generic', url, payload);
  }

  private async post(channel: string, url: string, payload: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // Broadcast responses are status-only. Dispose the body while the
      // request deadline is still armed so an endpoint cannot retain a
      // connection indefinitely by returning headers followed by an endless
      // stream. Cancellation is best-effort: incident writes must remain
      // isolated from broadcast transport cleanup failures.
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) {
        this.logger.warn(
          { component: 'incident-broadcast', channel, status: res.status },
          'broadcast webhook returned non-2xx',
        );
      }
    } catch (err) {
      this.logger.warn(
        {
          component: 'incident-broadcast',
          channel,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
              : { value: err },
        },
        'broadcast webhook failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
