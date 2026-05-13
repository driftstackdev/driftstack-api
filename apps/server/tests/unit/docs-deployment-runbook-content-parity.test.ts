// W553.C — drift guard for /docs/deployment/runbook.md.
// Operational runbook for routine triage. Drift here either
// weakens the V-195-standing-baseline + AGENTS.md-publish-vs-
// commercial-activation gating, drops the 5-quick-triage step
// (would slow first-customer-day MTTR), drops a standard-
// incident response (Postgres + Redis + Stripe + DLQ + Account
// abuse), or weakens the founder-authorize-on-decision policy.
//
//   • Drafted V-195 as standing baseline.
//   • Pre-launch — [TODO] gaps known + tracked.
//   • 5-step quick triage: /version + /ready + Sentry + Pino
//     + Stripe dashboard.
//   • 5 standard incidents: Postgres + Redis + Stripe webhooks
//     + DLQ growth + Account abuse / leaked key.
//   • DR runbook is separate: docs/deployment/dr-runbook.md.
//   • V-249 / V-246-P1-002 log-PII posture — magic-link/password-
//     reset enumeration emails logged at info on purpose.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/deployment/runbook.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W553.C /docs/deployment/runbook.md content parity', () => {
  const body = read(LIB);

  it("Header + V-195-pre-launch + AGENTS.md-publish-vs-commercial framing pinned: '# Driftstack API — operational runbook' + 'Drafted V-195 as the standing baseline for incident response and ops plays. Pre-launch — most procedures are forward-looking until real production traffic exists' + '**Status**: pre-launch. Everything in `[TODO]` is a known gap' + 'see AGENTS.md \"publish vs commercial activation\" — commercial activation is gated on entity registration, but ops infra needs to be ready when that gate opens' — pinned so the V-195-baseline + pre-launch-forward-looking + AGENTS.md-publish-vs-commercial + entity-registration-gate commitment survives", () => {
    expect(body).toMatch(/^# Driftstack API — operational runbook$/m);
    expect(body).toMatch(/Drafted V-195 as the standing baseline for incident response and ops/);
    expect(body).toMatch(/plays\. Pre-launch — most procedures are forward-looking until real/);
    expect(body).toMatch(/production traffic exists;/);
    expect(body).toMatch(
      /> \*\*Status\*\*: pre-launch\. Everything in `\[TODO\]` is a known gap and/,
    );
    expect(body).toMatch(/> should be filled before the first paying customer \(see AGENTS\.md/);
    expect(body).toMatch(/> "publish vs commercial activation" — commercial activation is gated/);
    expect(body).toMatch(/> on entity registration, but ops infra needs to be ready when that/);
    expect(body).toMatch(/> gate opens\)\./);
  });

  it("Quick-triage 5-step framing pinned: '## Quick triage' + 'Hit `/version` on the prod host** — confirm which build is running.' + 'Hit `/ready`** — every readiness check (postgres, redis, r2 if configured) reports `ok` + latency.' + '**Check Sentry** — error rate spike + most-frequent message.' + '**Check Pino logs** (Hetzner journalctl or wherever the server stdout is captured)' + '**Check Stripe dashboard** — webhook deliveries and subscription state if billing-related.' — pinned so the 5-step-triage (version + /ready + Sentry + Pino + Stripe) commitment survives", () => {
    expect(body).toMatch(/## Quick triage/);
    expect(body).toMatch(
      /1\. \*\*Hit `\/version` on the prod host\*\* — confirm which build is running\./,
    );
    expect(body).toMatch(
      /2\. \*\*Hit `\/ready`\*\* — every readiness check \(postgres, redis, r2 if/,
    );
    expect(body).toMatch(/configured\) reports `ok` \+ latency\./);
    expect(body).toMatch(/3\. \*\*Check Sentry\*\* — error rate spike \+ most-frequent message\./);
    expect(body).toMatch(/4\. \*\*Check Pino logs\*\* \(Hetzner journalctl or wherever the server/);
    expect(body).toMatch(/stdout is captured\)/);
    expect(body).toMatch(
      /5\. \*\*Check Stripe dashboard\*\* — webhook deliveries and subscription/,
    );
    expect(body).toMatch(/state if billing-related\./);
  });

  it("Known-endpoints + 5-incident framing pinned: '`GET /health`       | none | liveness — returns `{ ok: true }` always' + '`GET /ready`        | none | readiness — 200 if every check passes, 503 otherwise' + '`GET /version`      | none | build version + git sha + started_at + node version' + '`GET /v1/status`    | none | aggregate readiness — operational / degraded / major_outage' + '### Postgres unreachable' + '### Redis unreachable' + '### Stripe webhook delivery failures' + '### DLQ growth (webhook deliveries to customer endpoints)' + '### Account abuse / leaked key' — pinned so the /health-/ready-/version-/v1/status endpoints + 5-standard-incident framing commitment survives", () => {
    expect(body).toMatch(
      /`GET \/health`\s+\|\s+none\s+\|\s+liveness — returns `\{ ok: true \}` always/,
    );
    expect(body).toMatch(
      /`GET \/ready`\s+\|\s+none\s+\|\s+readiness — 200 if every check passes, 503 otherwise/,
    );
    expect(body).toMatch(
      /`GET \/version`\s+\|\s+none\s+\|\s+build version \+ git sha \+ started_at \+ node version/,
    );
    expect(body).toMatch(
      /`GET \/v1\/status`\s+\|\s+none\s+\|\s+aggregate readiness — operational \/ degraded \/ major_outage/,
    );
    expect(body).toMatch(/### Postgres unreachable/);
    expect(body).toMatch(/### Redis unreachable/);
    expect(body).toMatch(/### Stripe webhook delivery failures/);
    expect(body).toMatch(/### DLQ growth \(webhook deliveries to customer endpoints\)/);
    expect(body).toMatch(/### Account abuse \/ leaked key/);
  });

  it("DR-runbook cross-reference + Migration-rehearsal + Standing-observability framing pinned: 'For full disaster-recovery scenarios (Hetzner host loss, Postgres corruption, R2 loss, compromised key, bad deploy) see the dedicated DR runbook: `docs/deployment/dr-runbook.md`. The DR doc covers seven scenarios with RTO/RPO targets, recovery sequences, and a pre-launch dry-run checklist.' + 'Every Drizzle migration that runs against a non-empty production table follows the standing rehearsal sequence in `docs/deployment/migration-rehearsal.md`.' + '**Pino structured logs** — JSON to stdout; Hetzner journalctl ships' + '**Sentry** — server errors auto-reported; trace IDs included in the Pino log line via `request.id`.' — pinned so the 7-DR-scenario-cross-reference + Drizzle-migration-rehearsal + Pino-JSON-stdout-journalctl + Sentry-trace-IDs-request.id commitment survives", () => {
    expect(body).toMatch(/For full disaster-recovery scenarios \(Hetzner host loss, Postgres/);
    expect(body).toMatch(/corruption, R2 loss, compromised key, bad deploy\) see the dedicated/);
    expect(body).toMatch(
      /DR runbook: `docs\/deployment\/dr-runbook\.md`\. The DR doc covers seven/,
    );
    expect(body).toMatch(/scenarios with RTO\/RPO targets, recovery sequences, and a pre-launch/);
    expect(body).toMatch(/Every Drizzle migration that runs against a non-empty production/);
    expect(body).toMatch(/table follows the standing rehearsal sequence in/);
    expect(body).toMatch(/`docs\/deployment\/migration-rehearsal\.md`\./);
    expect(body).toMatch(
      /- \*\*Pino structured logs\*\* — JSON to stdout; Hetzner journalctl ships/,
    );
    expect(body).toMatch(
      /- \*\*Sentry\*\* — server errors auto-reported; trace IDs included in the/,
    );
    expect(body).toMatch(/Pino log line via `request\.id`\./);
  });

  it("Founder-authorize + V-249 log-PII-posture framing pinned: '## What to do if you can't reach the founder' + 'wait for the founder to authorize. Document the issue, take read-only diagnostic steps, and surface for explicit approval per the locked decision-authority policy in AGENTS.md.' + '## Log-handling — PII posture' + 'V-249 / V-246-P1-002 — operationally Pino logs may contain customer PII (email addresses) for the following intentional cases' + '`magic-link requested for unknown email` — `auth-flows.ts` line ~406. Logged at `info` so abuse patterns (enumeration attempts, password-spray scout traffic) are visible.' + '`password-reset requested for unknown email` — same shape, same posture.' + 'Raw Pino logs from production are Driftstack-internal-only. Don't share with non-Driftstack-staff (customers, support contractors) without scrubbing.' + 'Sentry breadcrumbs are scrubbed at emit time (V-242 `beforeSend` for the GUI client; existing apps/server Sentry config strips request bodies).' — pinned so the founder-authorize-decision-policy + V-249/V-246-P1-002-Pino-PII-posture + magic-link-enumeration-info + Driftstack-internal-only + V-242-Sentry-beforeSend-strip commitment survives", () => {
    expect(body).toMatch(/## What to do if you can't reach the founder/);
    expect(body).toMatch(/wait for the founder to authorize\. Document the/);
    expect(body).toMatch(/issue, take read-only diagnostic steps, and surface for explicit/);
    expect(body).toMatch(/approval per the locked decision-authority policy in AGENTS\.md\./);
    expect(body).toMatch(/## Log-handling — PII posture/);
    expect(body).toMatch(/V-249 \/ V-246-P1-002 — operationally Pino logs may contain customer/);
    expect(body).toMatch(/PII \(email addresses\) for the following intentional cases:/);
    expect(body).toMatch(
      /- `magic-link requested for unknown email` — `auth-flows\.ts` line ~406\./,
    );
    expect(body).toMatch(
      /Logged at `info` so abuse patterns \(enumeration attempts, password-spray scout traffic\) are visible\./,
    );
    expect(body).toMatch(
      /- `password-reset requested for unknown email` — same shape, same posture\./,
    );
    expect(body).toMatch(
      /- Raw Pino logs from production are Driftstack-internal-only\. Don't share with non-Driftstack-staff \(customers, support contractors\) without scrubbing\./,
    );
    expect(body).toMatch(
      /- Sentry breadcrumbs are scrubbed at emit time \(V-242 `beforeSend` for the GUI client; existing apps\/server Sentry config strips request bodies\)\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
