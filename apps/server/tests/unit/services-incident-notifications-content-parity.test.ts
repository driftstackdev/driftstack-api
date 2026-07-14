// W398.B — drift guard for apps/server/src/services/incident-notifications.ts.
// V-295c3-followup fan-out: wraps StatusSubscribersService + EmailService,
// notifyCreated / notifyResolved invoked by IncidentsService lifecycle.
// Drift either silently skips the unsubscribe-token rotation (one-click
// link breaks after first incident) or stops on the first failing
// recipient (one bad address poisons the batch).
//
//   • V-295c3-followup framing pinned + 4-step fan-out (snapshot
//     subscribers → rotate token per recipient → send template →
//     log).
//   • Per-recipient unsubscribe token rotation: one-click works
//     EXACTLY once per recipient per email.
//   • Fire-and-forget per recipient: one bad address can't poison
//     the batch.
//   • Serial dispatch (small list at launch); V-202d scheduled-jobs
//     swap framed for scale.
//   • statusPageBaseUrl trailing-slash strip.
//   • V-295c3-tombstone guard: listConfirmed only returns
//     unsubscribed_at IS NULL rows; email IS NOT NULL by invariant;
//     type-narrow check anyway.
//   • Empty recipient list early return (no email sent).
//   • Time pick: created → incident.startedAt; resolved →
//     incident.resolvedAt ?? new Date() fallback.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W398.B apps/server/src/services/incident-notifications.ts content parity', () => {
  const body = read(LIB);

  it('V-295c3-followup framing + 4-step fan-out pinned', () => {
    expect(body).toMatch(/V-295c3-followup — incident-notification fan-out\./);
    expect(body).toMatch(
      /Wraps StatusSubscribersService \+ EmailService and exposes\s*\n?\s*\/\/\s*`notifyCreated` \/ `notifyResolved` methods that the IncidentsService\s*\n?\s*\/\/\s*lifecycle hooks invoke\. Each method:/,
    );
    expect(body).toMatch(/1\. Snapshots the confirmed-subscriber list at notify-time\./);
    expect(body).toMatch(
      /2\. For each subscriber, rotates the unsubscribe token \(so the\s*\n?\s*\/\/\s*one-click unsub link in this specific email works exactly\s*\n?\s*\/\/\s*once per recipient\)/,
    );
    expect(body).toMatch(
      /3\. Sends the appropriate template \('created' or 'resolved'\) with\s*\n?\s*\/\/\s*a fresh personal unsubscribe URL\./,
    );
    expect(body).toMatch(
      /4\. Logs the fan-out count \+ per-recipient errors\. Each send is\s*\n?\s*\/\/\s*fire-and-forget; one bad address can't poison the batch\./,
    );
  });

  it('Serial-dispatch framing pinned: small list at launch; V-202d scheduled-jobs swap for scale', () => {
    expect(body).toMatch(
      /Dispatch is serial\. The subscriber list is small at launch; when\s*\n?\s*\/\/\s*scale becomes a concern, swap to the V-202d scheduled-jobs pattern\s*\n?\s*\/\/\s*with per-subscriber jobs\./,
    );
  });

  it('IncidentNotificationsConfig: statusPageBaseUrl (public origin of status site)', () => {
    expect(body).toMatch(/export interface IncidentNotificationsConfig \{/);
    expect(body).toMatch(/Public origin of the status site, used for link rendering\./);
    expect(body).toMatch(/statusPageBaseUrl: string;/);
  });

  it('Constructor: 4 required deps + optional V-545.B Phase 2 throttle repo; baseUrl trailing-slash strip', () => {
    expect(body).toMatch(/private readonly baseUrl: string;/);
    expect(body).toMatch(
      /constructor\(\s*\n?\s*private readonly subscribers: StatusSubscribersService,\s*\n?\s*private readonly email: EmailService,\s*\n?\s*private readonly logger: Logger,\s*\n?\s*config: IncidentNotificationsConfig,\s*\n?\s*\/\*\*[\s\S]+?\*\/\s*\n?\s*private readonly throttle\?: IncidentUpdateNotificationsRepo,\s*\n?\s*\) \{\s*\n?\s*this\.baseUrl = config\.statusPageBaseUrl\.replace\(\/\\\/\+\$\/, ''\);\s*\n?\s*\}/,
    );
  });

  it('notifyCreated / notifyResolved / notifyUpdated (V-545.B Phase 2): delegate to fanOut', () => {
    expect(body).toMatch(
      /async notifyCreated\(incident: IncidentRow, initialUpdate: IncidentUpdateRow\): Promise<void> \{\s*\n?\s*await this\.fanOut\(incident, initialUpdate, 'created'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async notifyResolved\(incident: IncidentRow, finalUpdate: IncidentUpdateRow\): Promise<void> \{\s*\n?\s*await this\.fanOut\(incident, finalUpdate, 'resolved'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async notifyUpdated\(incident: IncidentRow, update: IncidentUpdateRow\): Promise<void> \{\s*\n?\s*if \(!this\.throttle\) return;\s*\n?\s*await this\.fanOut\(incident, update, 'updated', this\.throttle\);\s*\n?\s*\}/,
    );
  });

  it('fanOut: empty recipient list → early return (no log, no email)', () => {
    expect(body).toMatch(/const recipients = await this\.subscribers\.listConfirmed\(\);/);
    expect(body).toMatch(/if \(recipients\.length === 0\) return;/);
  });

  it('Time-pick: created→startedAt; resolved→resolvedAt ?? new Date() fallback; updated→update.postedAt (V-545.B Phase 2)', () => {
    expect(body).toMatch(
      /const time =\s*\n?\s*kind === 'created'\s*\n?\s*\? incident\.startedAt\s*\n?\s*: kind === 'resolved'\s*\n?\s*\? \(incident\.resolvedAt \?\? new Date\(\)\)\s*\n?\s*: update\.postedAt;/,
    );
  });

  it('V-295c3-tombstone guard: listConfirmed returns email IS NOT NULL by invariant; type-narrow check anyway', () => {
    expect(body).toMatch(
      /\/\/ V-295c3-tombstone — listConfirmed only returns rows where\s*\n?\s*\/\/\s*unsubscribed_at IS NULL, so email IS NOT NULL by invariant\s*\n?\s*\/\/\s*\(purge only fires post-unsubscribe\)\. Guard for type-narrowing\./,
    );
    expect(body).toMatch(/if \(sub\.email === null\) continue;/);
  });

  it('Per-recipient: rotateUnsubscribeToken + encodeURIComponent unsubscribe link + sendStatusIncidentNotification with full payload', () => {
    expect(body).toMatch(
      /const unsubPlaintext = await this\.subscribers\.rotateUnsubscribeToken\(sub\.id\);/,
    );
    expect(body).toMatch(
      /const unsubscribeLink = `\$\{this\.baseUrl\}\/subscribe\/unsubscribe\/\?token=\$\{encodeURIComponent\(\s*\n?\s*unsubPlaintext,\s*\n?\s*\)\}`;/,
    );
    expect(body).toMatch(
      /await this\.email\.sendStatusIncidentNotification\(\{\s*\n?\s*to: sub\.email,\s*\n?\s*kind,\s*\n?\s*title: incident\.title,\s*\n?\s*severity: incident\.severity,\s*\n?\s*status: incident\.status,\s*\n?\s*message: update\.message,\s*\n?\s*incidentTime: time,\s*\n?\s*statusPageUrl: this\.baseUrl,\s*\n?\s*unsubscribeLink,\s*\n?\s*\}\);/,
    );
  });

  it('Per-recipient failure: caught + warn-log + failed++ (does NOT throw out of fanOut)', () => {
    expect(body).toMatch(/} catch \(err\) \{/);
    expect(body).toMatch(/failed \+= 1;/);
    expect(body).toMatch(
      /this\.logger\.warn\(\s*\n?\s*\{\s*\n?\s*component: 'incident-notifications',\s*\n?\s*email: maskEmail\(sub\.email\),\s*\n?\s*kind,\s*\n?\s*err:\s*\n?\s*err instanceof Error\s*\n?\s*\? \{ name: err\.name, message: err\.message, stack: err\.stack, cause: err\.cause \}\s*\n?\s*: \{ value: err \},\s*\n?\s*\},\s*\n?\s*'incident notification email failed',\s*\n?\s*\);/,
    );
  });

  it('Post-fanout: info log with ok / failed / throttled counts + incidentId (V-545.B Phase 2)', () => {
    expect(body).toMatch(
      /this\.logger\.info\(\s*\n?\s*\{ component: 'incident-notifications', kind, incidentId: incident\.id, ok, failed, throttled \},\s*\n?\s*'fan-out complete',\s*\n?\s*\);/,
    );
  });

  it('imports: Logger + EmailService + IncidentRow/IncidentUpdateRow + StatusSubscribersService', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import type \{ EmailService \} from '\.\/email\.js';/);
    expect(body).toMatch(
      /import type \{ IncidentRow, IncidentUpdateRow \} from '\.\/incidents\.js';/,
    );
    expect(body).toMatch(
      /import type \{ StatusSubscribersService \} from '\.\/status-subscribers\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
