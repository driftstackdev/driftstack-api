// V-295c3-followup — incident-notification fan-out.
//
// Wraps StatusSubscribersService + EmailService and exposes
// `notifyCreated` / `notifyResolved` methods that the IncidentsService
// lifecycle hooks invoke. Each method:
//
//   1. Snapshots the confirmed-subscriber list at notify-time.
//   2. For each subscriber, rotates the unsubscribe token (so the
//      one-click unsub link in this specific email works exactly
//      once per recipient).
//   3. Sends the appropriate template ('created' or 'resolved') with
//      a fresh personal unsubscribe URL.
//   4. Logs the fan-out count + per-recipient errors. Each send is
//      fire-and-forget; one bad address can't poison the batch.
//
// Dispatch is serial. The subscriber list is small at launch; when
// scale becomes a concern, swap to the V-202d scheduled-jobs pattern
// with per-subscriber jobs.

import type { Logger } from '../lib/logger.js';
import type { EmailService } from './email.js';
import type { IncidentRow, IncidentUpdateRow } from './incidents.js';
import type { StatusSubscribersService } from './status-subscribers.js';

export interface IncidentNotificationsConfig {
  /** Public origin of the status site, used for link rendering. */
  statusPageBaseUrl: string;
}

export class IncidentNotificationsService {
  private readonly baseUrl: string;

  constructor(
    private readonly subscribers: StatusSubscribersService,
    private readonly email: EmailService,
    private readonly logger: Logger,
    config: IncidentNotificationsConfig,
  ) {
    this.baseUrl = config.statusPageBaseUrl.replace(/\/+$/, '');
  }

  async notifyCreated(incident: IncidentRow, initialUpdate: IncidentUpdateRow): Promise<void> {
    await this.fanOut(incident, initialUpdate, 'created');
  }

  async notifyResolved(incident: IncidentRow, finalUpdate: IncidentUpdateRow): Promise<void> {
    await this.fanOut(incident, finalUpdate, 'resolved');
  }

  private async fanOut(
    incident: IncidentRow,
    update: IncidentUpdateRow,
    kind: 'created' | 'resolved',
  ): Promise<void> {
    const recipients = await this.subscribers.listConfirmed();
    if (recipients.length === 0) return;
    const time = kind === 'created' ? incident.startedAt : (incident.resolvedAt ?? new Date());
    let ok = 0;
    let failed = 0;
    for (const sub of recipients) {
      try {
        const unsubPlaintext = await this.subscribers.rotateUnsubscribeToken(sub.id);
        const unsubscribeLink = `${this.baseUrl}/subscribe/unsubscribe?token=${encodeURIComponent(
          unsubPlaintext,
        )}`;
        await this.email.sendStatusIncidentNotification({
          to: sub.email,
          kind,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          message: update.message,
          incidentTime: time,
          statusPageUrl: this.baseUrl,
          unsubscribeLink,
        });
        ok += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          {
            component: 'incident-notifications',
            email: sub.email,
            kind,
            err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
          },
          'incident notification email failed',
        );
      }
    }
    this.logger.info(
      { component: 'incident-notifications', kind, incidentId: incident.id, ok, failed },
      'fan-out complete',
    );
  }
}
