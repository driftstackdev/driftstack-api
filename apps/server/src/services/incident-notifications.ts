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
import { maskEmail } from '../lib/redact-url.js';
import type { IncidentUpdateNotificationsRepo } from '../db/incident-update-notifications-repo.js';
import type { EmailService } from './email.js';
import type { IncidentRow, IncidentUpdateRow } from './incidents.js';
import type { StatusSubscribersService } from './status-subscribers.js';

export interface IncidentNotificationsConfig {
  /** Public origin of the status site, used for link rendering. */
  statusPageBaseUrl: string;
}

// V-545.B Phase 2 — 1 hour minimum gap between per-subscriber update
// emails for the same incident. Doc-locked default; could surface as
// per-account preference later.
const UPDATE_THROTTLE_MS = 60 * 60 * 1000;

export class IncidentNotificationsService {
  private readonly baseUrl: string;

  constructor(
    private readonly subscribers: StatusSubscribersService,
    private readonly email: EmailService,
    private readonly logger: Logger,
    config: IncidentNotificationsConfig,
    /** V-545.B Phase 2 — optional; when omitted, notifyUpdated is a
     *  no-op (the throttle table is the gating dependency). */
    private readonly throttle?: IncidentUpdateNotificationsRepo,
  ) {
    this.baseUrl = config.statusPageBaseUrl.replace(/\/+$/, '');
  }

  async notifyCreated(incident: IncidentRow, initialUpdate: IncidentUpdateRow): Promise<void> {
    await this.fanOut(incident, initialUpdate, 'created');
  }

  async notifyResolved(incident: IncidentRow, finalUpdate: IncidentUpdateRow): Promise<void> {
    await this.fanOut(incident, finalUpdate, 'resolved');
  }

  /** V-545.B Phase 2 — per-update fan-out. Throttled to at most one
   *  email per subscriber per incident per UPDATE_THROTTLE_MS window.
   *  No-op when constructed without a throttle repo. */
  async notifyUpdated(incident: IncidentRow, update: IncidentUpdateRow): Promise<void> {
    if (!this.throttle) return;
    await this.fanOut(incident, update, 'updated', this.throttle);
  }

  private async fanOut(
    incident: IncidentRow,
    update: IncidentUpdateRow,
    kind: 'created' | 'updated' | 'resolved',
    throttle?: IncidentUpdateNotificationsRepo,
  ): Promise<void> {
    const recipients = await this.subscribers.listConfirmed();
    if (recipients.length === 0) return;
    const time =
      kind === 'created'
        ? incident.startedAt
        : kind === 'resolved'
          ? (incident.resolvedAt ?? new Date())
          : update.postedAt;
    const now = Date.now();
    let ok = 0;
    let failed = 0;
    let throttled = 0;
    for (const sub of recipients) {
      // V-295c3-tombstone — listConfirmed only returns rows where
      // unsubscribed_at IS NULL, so email IS NOT NULL by invariant
      // (purge only fires post-unsubscribe). Guard for type-narrowing.
      if (sub.email === null) continue;
      // V-545.B Phase 2 — throttle check for the 'updated' kind only.
      if (throttle && kind === 'updated') {
        const lastSent = await throttle.findLastSentAt(sub.id, incident.id);
        if (lastSent && now - lastSent.getTime() < UPDATE_THROTTLE_MS) {
          throttled += 1;
          continue;
        }
      }
      try {
        const unsubPlaintext = await this.subscribers.rotateUnsubscribeToken(sub.id);
        const unsubscribeLink = `${this.baseUrl}/subscribe/unsubscribe/?token=${encodeURIComponent(
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
        if (throttle && kind === 'updated') {
          await throttle.markSent(sub.id, incident.id, new Date(now));
        }
      } catch (err) {
        failed += 1;
        this.logger.warn(
          {
            component: 'incident-notifications',
            email: maskEmail(sub.email),
            kind,
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                : { value: err },
          },
          'incident notification email failed',
        );
      }
    }
    this.logger.info(
      { component: 'incident-notifications', kind, incidentId: incident.id, ok, failed, throttled },
      'fan-out complete',
    );
  }
}
