// W556.C — drift guard for /docs/runbooks/observability.md.
// V-513 ops observability reference. Drift here either weakens
// the EU-region-Sentry posture (would invite a US-region DSN
// that fails config validator), drops the per-service project
// layout (would re-permit a single multi-service DSN), or weakens
// the synthetic-check / load-test cadence.
//
//   • V-513. Pre-launch reference.
//   • All Sentry projects EU region (ingest.de.sentry.io). DSNs
//     without `.de.` rejected at boot by apps/server/src/lib/
//     config.ts:63.
//   • 6 Sentry projects per V-469 (server + customer-dashboard +
//     marketing + docs + status-site + admin-panel).
//   • V-289 synthetic checks: 60s for api/* + status, 5min for
//     others. 2 consecutive fails = page.
//   • V-495 load-test cadence: pre-deploy + weekly + quarterly +
//     post-architecture-change.
//   • DLQ admin paths: per-endpoint + cross-account. Replay vs
//     requeue distinct admin-audit-log shapes.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/observability.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W556.C /docs/runbooks/observability.md content parity', () => {
  const body = read(LIB);

  it("Header + V-513 + layers-and-tools framing pinned: '# Observability runbook (V-513)' + 'How Driftstack instruments, monitors, and alerts on its production control plane.' + 'V-469 (per-service Sentry projects), V-289 (synthetic checks), V-474 (StatusBadge → /v1/status), V-494 (log + Sentry redaction).' + 'Logs             | pino → stdout → journalctl on Hetzner' + 'Errors           | Sentry (EU region: `ingest.de.sentry.io`)' + 'Synthetics       | V-289 healthchecks (every 60s)' + 'Status surface   | `/v1/status` + StatusBadge (V-474)' + 'Status site      | `apps/status-site/` (Cloudflare Pages)' + 'Synthetic events | `test.ping` webhook (V-475)' + 'DLQ              | `/v1/admin/webhook-dlq` + V-512 endpoint filter' + 'Load test        | `scripts/load-test/run.mjs` (V-495)' + 'Audit logs       | `account_audit_log` + `admin_audit_log` (D-025)' — pinned so the V-513-pre-launch + V-469/V-289/V-474/V-494 V-anchor inventory + 9-row layer-tool table + EU-ingest.de.sentry.io commitment survives", () => {
    expect(body).toMatch(/^# Observability runbook \(V-513\)$/m);
    expect(body).toMatch(/How Driftstack instruments, monitors, and alerts on its production/);
    expect(body).toMatch(/control plane\./);
    expect(body).toMatch(
      /V-469\s*\(per-service Sentry projects\), V-289 \(synthetic checks\), V-474/,
    );
    expect(body).toMatch(/\(StatusBadge → \/v1\/status\), V-494 \(log \+ Sentry redaction\)\./);
    expect(body).toMatch(/Logs\s+\|\s+pino → stdout → journalctl on Hetzner/);
    expect(body).toMatch(/Errors\s+\|\s+Sentry \(EU region: `ingest\.de\.sentry\.io`\)/);
    expect(body).toMatch(/Synthetics\s+\|\s+V-289 healthchecks \(every 60s\)/);
    expect(body).toMatch(/Status surface\s+\|\s+`\/v1\/status` \+ StatusBadge \(V-474\)/);
    expect(body).toMatch(/Status site\s+\|\s+`apps\/status-site\/` \(Cloudflare Pages\)/);
    expect(body).toMatch(/Synthetic events \| `test\.ping` webhook \(V-475\)/);
    expect(body).toMatch(/DLQ\s+\|\s+`\/v1\/admin\/webhook-dlq` \+ V-512 endpoint filter/);
    expect(body).toMatch(/Load test\s+\|\s+`scripts\/load-test\/run\.mjs` \(V-495\)/);
    expect(body).toMatch(/Audit logs\s+\|\s+`account_audit_log` \+ `admin_audit_log` \(D-025\)/);
  });

  it("Sentry V-469 7-project layout + EU-validator framing pinned: '## Sentry project layout (V-469)' + 'Per-service projects, all under the same EU region (`ingest.de.sentry.io`)' + 7-project Status-column table (server + gui + dashboard + marketing + docs + status-site + admin-panel) + 'SENTRY_DSN'-as-server-runtime-env + 'SENTRY_DSN_SERVER'-as-gh-secret-disambiguator + per-app PUBLIC_SENTRY_DSN_* gh-secret mapping + EU-validator '.de.' / '.ingest.de.sentry.io' rejection. Updated 2026-05-15 when remaining 4 projects landed live.", () => {
    expect(body).toMatch(/## Sentry project layout \(V-469\)/);
    expect(body).toMatch(
      /Per-service projects, all under the same EU region \(`ingest\.de\.sentry\.io`\):/,
    );
    // 7-row project status table
    expect(body).toMatch(
      /`driftstack-server`\s+\|\s+`apps\/server\/`\s+\|\s+Yes — every API request\s+\|\s+live/,
    );
    expect(body).toMatch(
      /`driftstack-gui`\s+\|\s+`apps\/gui-client\/`\s+\|\s+Yes — desktop GUI errors\s+\|\s+live/,
    );
    expect(body).toMatch(
      /`driftstack-dashboard`\s+\|\s+`apps\/customer-dashboard\/`\s+\|\s+Yes — dashboard UI errors\s+\|\s+live/,
    );
    expect(body).toMatch(
      /`driftstack-marketing`\s+\|\s+`apps\/marketing-site\/`\s+\|\s+Lower priority\s+\|\s+live/,
    );
    expect(body).toMatch(
      /`driftstack-docs`\s+\|\s+`apps\/docs\/`\s+\|\s+Lower priority\s+\|\s+live/,
    );
    expect(body).toMatch(
      /`driftstack-status-site`\s+\|\s+`apps\/status-site\/`\s+\|\s+Yes — outage-time critical\s+\|\s+live/,
    );
    expect(body).toMatch(
      /`driftstack-admin-panel`\s+\|\s+`apps\/admin-panel\/`\s+\|\s+Internal-only\s+\|\s+live/,
    );
    // env-var → gh-secret mapping
    expect(body).toMatch(/Server-side DSNs are read via\s*\n?`SENTRY_DSN`/);
    expect(body).toMatch(/`SENTRY_DSN_SERVER`/);
    expect(body).toMatch(/`PUBLIC_SENTRY_DSN_DASHBOARD`/);
    expect(body).toMatch(/`PUBLIC_SENTRY_DSN_MARKETING`/);
    expect(body).toMatch(/`PUBLIC_SENTRY_DSN_DOCS`/);
    expect(body).toMatch(/`PUBLIC_SENTRY_DSN_STATUS_SITE`/);
    expect(body).toMatch(/`PUBLIC_SENTRY_DSN_ADMIN_PANEL`/);
    // The client apps are Astro (PUBLIC_ build-time env), never Next.js — a
    // NEXT_PUBLIC_ var name would send operators to set a var no app reads
    // (Sentry silently disabled). astro.config.mjs reads PUBLIC_SENTRY_DSN_*.
    expect(body).not.toMatch(/NEXT_PUBLIC/);
    // EU validator
    expect(body).toMatch(
      /The validator in `apps\/server\/src\/lib\/config\.ts:63` enforces\s*\n?the EU region — DSNs without `\.de\.` or `\.ingest\.de\.sentry\.io`\s*\n?are rejected at boot\./,
    );
  });

  it("Alert rules + driftstack-server top-priority framing pinned: '### `driftstack-server` (highest signal-to-noise)' + '`*.fatal` events           | Any new event tagged `level:fatal`                               | Page founder phone immediately (P-0 §5.2)' + 'Error spike — auth path    | >10 `level:error` events in 5min on `/v1/auth/*`                 | Slack #alerts (P-1 within 30min)' + 'Error spike — billing path | >5 `level:error` events in 5min on `/v1/billing/*`               | Slack #alerts' + 'Stripe webhook failures    | >3 `level:error` events in 1min from `routes/webhooks-stripe.ts` | Slack #alerts' + 'driftstack-status-site' + 'Higher sensitivity because if the status site itself is broken during an incident, customers can't see what's happening' + 'Any error | >0 events in 5min | Page founder' — pinned so the *.fatal-page-founder-P-0 + auth-path >10/5min + billing-path >5/5min + Stripe-webhook >3/1min + status-site-any-error-page commitment survives", () => {
    expect(body).toMatch(/### `driftstack-server` \(highest signal-to-noise\)/);
    expect(body).toMatch(
      /`\*\.fatal` events\s+\|\s+Any new event tagged `level:fatal`\s+\|\s+Page founder phone immediately \(P-0 §5\.2\)/,
    );
    expect(body).toMatch(
      /Error spike — auth path\s+\|\s+>10 `level:error` events in 5min on `\/v1\/auth\/\*`\s+\|\s+Slack #alerts \(P-1 within 30min\)/,
    );
    expect(body).toMatch(
      /Error spike — billing path \| >5 `level:error` events in 5min on `\/v1\/billing\/\*`\s+\|\s+Slack #alerts/,
    );
    expect(body).toMatch(
      /Stripe webhook failures\s+\|\s+>3 `level:error` events in 1min from `routes\/webhooks-stripe\.ts` \| Slack #alerts/,
    );
    expect(body).toMatch(/### `driftstack-status-site`/);
    expect(body).toMatch(/Higher sensitivity because if the status site itself is broken/);
    expect(body).toMatch(/during an incident, customers can't see what's happening:/);
    expect(body).toMatch(/Any error \| >0 events in 5min \| Page founder/);
  });

  it("Synthetic checks V-289 + load-test V-495 framing pinned: '## Synthetic checks (V-289)' + '`https://api.driftstack.dev/health`    | 60s      | 5s      | 2 consecutive → page' + '`https://api.driftstack.dev/ready`     | 60s      | 10s     | 2 consecutive → page' + '`https://api.driftstack.dev/v1/status` | 60s      | 5s      | 2 consecutive → page' + '`https://app.driftstack.dev`           | 5min     | 10s     | 1 failure → Slack' + '`https://status.driftstack.dev`        | 60s      | 5s      | 2 consecutive → page' + 'Synthetic check fails route through the same P-0 channels as Sentry fatals (per `docs/runbooks/incidents.md` §5.2).' + '## Load-test cadence (V-495)' + 'Pre-deploy of new version     | staging — `/v1/status`   | Compare to last' + 'Weekly                        | production — read-only   | Append to baselines' + 'Quarterly                     | production — write paths | Append + compare to Q-1' + 'After any architecture change | both                     | Mandatory' + 'The harness refuses to mutate production without explicit `--i-know-what-im-doing=true`' — pinned so the V-289-7-target-synthetic-table + 60s-api-status + 5min-others + P-0-route-via-incidents-§5.2 + V-495-4-cadence-row + --i-know-what-im-doing safety rail commitment survives", () => {
    expect(body).toMatch(/## Synthetic checks \(V-289\)/);
    expect(body).toMatch(
      /`https:\/\/api\.driftstack\.dev\/health`\s+\|\s+60s\s+\|\s+5s\s+\|\s+2 consecutive → page/,
    );
    expect(body).toMatch(
      /`https:\/\/api\.driftstack\.dev\/ready`\s+\|\s+60s\s+\|\s+10s\s+\|\s+2 consecutive → page/,
    );
    expect(body).toMatch(
      /`https:\/\/api\.driftstack\.dev\/v1\/status` \| 60s\s+\|\s+5s\s+\|\s+2 consecutive → page/,
    );
    expect(body).toMatch(
      /`https:\/\/app\.driftstack\.dev`\s+\|\s+5min\s+\|\s+10s\s+\|\s+1 failure → Slack/,
    );
    expect(body).toMatch(
      /`https:\/\/status\.driftstack\.dev`\s+\|\s+60s\s+\|\s+5s\s+\|\s+2 consecutive → page/,
    );
    expect(body).toMatch(/Synthetic check fails route through the same P-0 channels as/);
    expect(body).toMatch(/Sentry fatals \(per `docs\/runbooks\/incidents\.md` §5\.2\)\./);
    expect(body).toMatch(/## Load-test cadence \(V-495\)/);
    expect(body).toMatch(
      /Pre-deploy of new version\s+\|\s+staging — `\/v1\/status`\s+\|\s+Compare to last/,
    );
    expect(body).toMatch(/Weekly\s+\|\s+production — read-only\s+\|\s+Append to baselines/);
    expect(body).toMatch(/Quarterly\s+\|\s+production — write paths \| Append \+ compare to Q-1/);
    expect(body).toMatch(/After any architecture change \| both\s+\|\s+Mandatory/);
    expect(body).toMatch(/The harness refuses to mutate production without explicit/);
    expect(body).toMatch(/`--i-know-what-im-doing=true`/);
  });

  it("DLQ + audit-log-retention + Sentry-env-vars framing pinned: '## DLQ triage workflow' + 'Per-customer triage** — V-512 `endpoint_id` filter' + 'GET /v1/admin/webhook-dlq?endpoint_id=webhook_endpoint_<uuid>' + 'Cross-account triage** — no filter' + 'GET /v1/admin/webhook-dlq' + '`POST /v1/admin/webhook-deliveries/:id/replay` — works on delivered + dlq + failed states. Records as `webhook_delivery.replayed`' + '`POST /v1/admin/webhook-dlq/:id/requeue` — works on DLQ only; 409 if not in DLQ. Records as `webhook_delivery.requeued`.' + 'replay = \"we asked for this to be re-sent on purpose\"; requeue = \"this got stuck because something temporary.\"' + '## Audit-log retention' + 'V-498 audit closure' + 'Both tables are RPO-zero from the DR runbook's Scenario 2 PITR recovery posture.' + '## Per-service Sentry env vars' + '`SENTRY_DSN_SERVER` — server project DSN' + '`SENTRY_TRACES_SAMPLE_RATE` — 0..1 (default 0)' — pinned so the per-customer-V-512-filter + cross-account-no-filter + replay-vs-requeue-audit-distinction + V-498-audit-closure + RPO-zero-Scenario-2-PITR + SENTRY_TRACES_SAMPLE_RATE-0-default commitment survives", () => {
    expect(body).toMatch(/## DLQ triage workflow/);
    expect(body).toMatch(/1\. \*\*Per-customer triage\*\* — V-512 `endpoint_id` filter:/);
    expect(body).toMatch(/GET \/v1\/admin\/webhook-dlq\?endpoint_id=webhook_endpoint_<uuid>/);
    expect(body).toMatch(/2\. \*\*Cross-account triage\*\* — no filter:/);
    expect(body).toMatch(/GET \/v1\/admin\/webhook-dlq/);
    expect(body).toMatch(/- `POST \/v1\/admin\/webhook-deliveries\/:id\/replay` — works on/);
    expect(body).toMatch(/delivered \+ dlq \+ failed states\. Records as/);
    expect(body).toMatch(/`webhook_delivery\.replayed`/);
    expect(body).toMatch(/- `POST \/v1\/admin\/webhook-dlq\/:id\/requeue` — works on DLQ only;/);
    expect(body).toMatch(/409 if not in DLQ\. Records as `webhook_delivery\.requeued`\./);
    expect(body).toMatch(
      /replay = "we asked\s*for this to be re-sent on purpose"; requeue = "this got stuck/,
    );
    expect(body).toMatch(/because something temporary\."/);
    expect(body).toMatch(/## Audit-log retention/);
    expect(body).toMatch(/V-498 audit closure/);
    expect(body).toMatch(/Both tables are RPO-zero from the DR runbook's Scenario 2 PITR/);
    expect(body).toMatch(/recovery posture\./);
    expect(body).toMatch(/## Per-service Sentry env vars/);
    expect(body).toMatch(/- `SENTRY_DSN_SERVER` — server project DSN/);
    expect(body).toMatch(/- `SENTRY_TRACES_SAMPLE_RATE` — 0\.\.1 \(default 0\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
