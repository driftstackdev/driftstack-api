// Every service built to run on a tick is actually run, or is recorded as
// deliberately not running.
//
// A `tickOnce(...)` method is this codebase's shape for "a sweep the scheduler
// drives". Fourteen service classes have one. Thirteen are constructed in
// bootstrap. The fourteenth is complete, has DB columns, has an email template,
// has its own tests — and is wired nowhere, so it has never run in production
// and nothing said so.
//
// That failure is silent by construction: a service that is never constructed
// throws nothing, logs nothing, and leaves every one of its own unit tests
// green. It is the same shape as the retention purge being gated behind an
// unrelated flag, and as a job chain dying — a capability that looks shipped
// from every angle except the one nobody checks.
//
// So the roster is the check. A service either appears in bootstrap or appears
// below with the reason it does not, which turns "we forgot" into "we decided".

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const SERVICES = resolve(SRC, 'services');

/**
 * Services that are built and tested but deliberately not running, each with
 * the reason and what it would take to turn them on.
 *
 * An entry here is a claim that NOT running is the current intent — not a
 * parking space for something half-finished.
 */
const NOT_WIRED_PENDING_DECISION: Record<string, string> = {
  WebhookSecretForceRotationService:
    'Auto-rotates webhook signing secrets past 91 days and emails the customer the ' +
    'new prefix plus a 7-day grace deadline. Complete and viable — the DB columns ' +
    '(force_rotated_at, grace_window_ends_at) exist, the sendWebhookSecretForceRotated ' +
    'template exists, and its sibling WebhookGraceExpiringNoticeService IS wired, so ' +
    'the half that warns about expiring grace windows runs while the half that opens ' +
    'them does not. Turning it on rotates live customer secrets and breaks any ' +
    'integration that does not update inside the grace window, so it is an outward-facing ' +
    'call rather than a wiring fix.',
  AuditArchiveService:
    'ADR-006 90-day archiver. Sweeps rows older than 90 days out of five tables ' +
    '(admin_audit_log, processed_stripe_events, legal_acceptances, webhook_deliveries ' +
    'and the high-volume session_events action log) into R2 as gzipped JSON Lines, ' +
    'then DELETEs them. Complete and tested, and audit_archive_runs exists with ZERO ' +
    'rows — it has never run, so those tables have no retention bound and the ' +
    'privacy-policy line about session metadata being 90-day operational has no ' +
    'mechanism behind it. Turning it on deletes production rows after an R2 upload, ' +
    'which is a data-movement decision rather than a wiring fix.',
  DurableWebhookDeliveryService:
    'The V-173 FORWARD path for webhook delivery. Its own header describes replacing ' +
    'the live service as "a separate future V-NNN once V-173 has soak time", so being ' +
    'unconstructed is the intended state until that cutover. Its claim query is kept ' +
    'in step with the live one by webhook-claim-fairness-parity, so cutting over ' +
    'cannot silently reintroduce the endpoint starvation fixed in 84dc306b1.',
};

interface TickService {
  readonly name: string;
  readonly file: string;
}

/**
 * Service classes that are supposed to be constructed by the application.
 *
 * Two shapes, because one alone was not enough. A `tickOnce` method is the
 * sweep shape and was the original signal — but `AuditArchiveService` enforces
 * a 90-day retention across five tables through `archiveTable()`, has no
 * `tickOnce`, and had never run. A tick-only check could not see it. The
 * broader property is simply "a *Service the app never constructs", and 51 of
 * the 54 exported services satisfy it, so the signal stays tight.
 */
function candidateServices(): TickService[] {
  const out: TickService[] = [];
  for (const entry of readdirSync(SERVICES)) {
    if (!entry.endsWith('.ts')) continue;
    const src = readFileSync(resolve(SERVICES, entry), 'utf8');
    const tickShaped = /\n\s+(?:async )?tickOnce\s*\(/.test(src);
    for (const m of src.matchAll(/^export class (\w+)/gm)) {
      const name = m[1]!;
      if (tickShaped || name.endsWith('Service')) out.push({ name, file: entry });
    }
  }
  return out;
}

/**
 * Is this service constructed anywhere the application actually runs?
 *
 * Deliberately NOT "constructed in bootstrap". Wiring happens in more than one
 * place — `OAuthService` is built in `lib/app.ts` — and a bootstrap-only check
 * reported it as orphaned when it is perfectly live. Its own file is excluded
 * because a class constructed only by its own factory is not wired by anything:
 * that is exactly `DurableWebhookDeliveryService`, whose sole construction is
 * inside a factory nothing calls.
 */
function wiredInApplication(name: string, ownFile: string): boolean {
  const needle = new RegExp(`\\bnew ${name}\\s*\\(`);
  const stack: string[] = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.ts') && full !== resolve(SERVICES, ownFile)) {
        if (needle.test(readFileSync(full, 'utf8'))) return true;
      }
    }
  }
  return false;
}

describe('every tick-driven service is wired, or recorded as deliberately not', () => {
  const services = candidateServices();

  it('CRITICAL the scan found the tick-service surface. An empty scan would make the check below vacuous — and the failure it guards is itself an absence, so a broken scan would hide the same thing twice.', () => {
    expect(services.length, 'service classes exposing tickOnce()').toBeGreaterThan(8);
    expect(
      services.map((s) => s.name),
      'a known wired sweeper must survive the scan',
    ).toContain('ProfileTrashPurgeSweeperService');
    expect(
      services.map((s) => s.name),
      'and so must the known unwired one',
    ).toContain('WebhookSecretForceRotationService');
  });

  it('CRITICAL no tick-driven service is unwired without a stated reason. A service nothing constructs throws nothing, logs nothing, and keeps every one of its own tests green — it looks shipped from every angle except the one nobody checks.', () => {
    const orphaned = services
      .filter((s) => !wiredInApplication(s.name, s.file))
      .filter((s) => NOT_WIRED_PENDING_DECISION[s.name] === undefined)
      .map((s) => `${s.name} (${s.file})`);

    expect(
      orphaned.sort(),
      'tick-driven service(s) built but never constructed — wire them in bootstrap, or record why not in NOT_WIRED_PENDING_DECISION:',
    ).toEqual([]);
  });

  it('CRITICAL the pending-decision list may only SHRINK — a service that becomes wired must leave it, and an entry naming a service that no longer exists must go too. Otherwise the list stops meaning "decided" and starts meaning "ignored".', () => {
    const nowWired = Object.keys(NOT_WIRED_PENDING_DECISION)
      .filter((name) => services.some((s) => s.name === name && wiredInApplication(s.name, s.file)))
      .sort();
    expect(nowWired, 'these are wired now — remove them from NOT_WIRED_PENDING_DECISION:').toEqual(
      [],
    );

    const known = new Set(services.map((s) => s.name));
    const stale = Object.keys(NOT_WIRED_PENDING_DECISION)
      .filter((name) => !known.has(name))
      .sort();
    expect(stale, 'entries for services that no longer expose a tickOnce:').toEqual([]);
  });

  it('records the current split, so the one unwired service is a visible number rather than a thing someone has to go looking for', () => {
    const unwired = services.filter((s) => !wiredInApplication(s.name, s.file)).map((s) => s.name);
    expect(unwired.sort()).toEqual([
      'AuditArchiveService',
      'DurableWebhookDeliveryService',
      'WebhookSecretForceRotationService',
    ]);
  });
});
