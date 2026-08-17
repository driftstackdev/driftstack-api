// Drift guard for the dormant webhook force-rotation implementation and its
// production-wiring safety boundary. The plaintext-once API cannot reveal a
// server-generated secret after the sweep discards it, so bootstrap must not
// import, construct or schedule this service. Direct unit coverage remains to
// preserve the implementation until a secure one-time handoff is designed.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/webhook-secret-force-rotation.ts');
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/webhook-secret-force-rotation content parity', () => {
  const body = read(LIB);
  const bootstrap = read(BOOTSTRAP);

  it('is not wired into production bootstrap while its generated plaintext has no customer recovery channel', () => {
    expect(bootstrap).not.toContain('WebhookSecretForceRotationService');
    expect(bootstrap).not.toContain('webhookSecretForceRotationService');
    expect(bootstrap).not.toContain('webhookSecretForceRotationTimer');
    expect(bootstrap).not.toContain('webhook-force-rotation-poller');
    expect(bootstrap).toContain('new WebhookRotationReminderService(');
    expect(bootstrap).toContain('new WebhookGraceExpiringNoticeService(');
    // V-784 — the cleanup is now a daily job chain rather than a setInterval,
    // so the tick's `now` arrives as the handler argument instead of being
    // constructed at the call site. What this case is really asserting is that
    // the recovery-path cleanup stays wired while the force-rotation PRODUCER
    // stays unwired, and that survives the call-shape change.
    expect(bootstrap).toContain('webhooksRepo.clearStaleSecretPrev({ now })');
    expect(bootstrap).toContain('jobType: WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE,');
    expect(bootstrap).not.toContain('webhookSecretPrevCleanupTimer');
  });

  it('CRITICAL stays dark across ALL of src, not just bootstrap', () => {
    // The arm above reads bootstrap.ts only. The boundary it protects is "this
    // service never runs in production", and nothing about that is specific to
    // one file — app.ts wires plenty of services, and a wiring added there would
    // satisfy every check above while the sweep starts discarding secrets whose
    // plaintext has no customer recovery channel.
    //
    // Matches CONSTRUCTION and IMPORT rather than the name: three service files
    // legitimately mention it in comments describing the shared tick shape, and
    // a name-only scan would either flag those or have to be weakened to nothing.
    const SRC = resolve(REPO_ROOT, 'apps/server/src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || full === LIB) continue;
        const body = read(full);
        if (
          /new WebhookSecretForceRotationService\s*\(/.test(body) ||
          /from '[^']*webhook-secret-force-rotation\.js'/.test(body)
        ) {
          offenders.push(full.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    expect(
      offenders,
      'the dormant force-rotation service is constructed or imported in production source. Its ' +
        'sweep replaces a webhook secret and discards the plaintext, and the plaintext-once API ' +
        'cannot reveal it afterwards — customers would be left with an endpoint they can no ' +
        'longer verify signatures for, and no recovery channel',
    ).toEqual([]);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Arc 3 sub-slice 28.2 module-level framing pinned: 'webhook secret server-initiated force-rotation. Daily sweep that auto-rotates webhook signing secrets past the 91-day age threshold (Q1=B). For each rotated endpoint: 1. Mint fresh secret via WebhooksRepo.forceRotateSecret (sub-slice 28.1 columns get stamped — graceWindowEndsAt = now + 7d per Q2=B; forceRotatedAt = now so this sweep skips it next cycle). 2. Email the customer the new secret prefix + 7-day grace deadline (sub-slice 28.4 template wiring lands separately; this slice fires the existing rotation-reminder email shape for now).' — pinned so the 28.2 anchor + 91-day-Q1=B threshold + 7-day-grace-Q2=B + force_rotated_at-stamps-prevent-loop + 28.1 column reference + 28.4 template-wiring-deferred all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Arc 3 sub-slice 28\.2 \(v2-#28 webhook secret server-initiated force-rotation\)\./,
    );
    expect(body).toMatch(
      /\/\/ Daily sweep that auto-rotates webhook signing secrets past the\s*\n?\s*\/\/ 91-day age threshold \(Q1=B\)\. For each rotated endpoint:/,
    );
    expect(body).toMatch(
      /\/\/ {3}1\. Mint fresh secret via WebhooksRepo\.forceRotateSecret \(sub-\s*\n?\s*\/\/ {6}slice 28\.1 columns get stamped — graceWindowEndsAt = now \+ 7d\s*\n?\s*\/\/ {6}per Q2=B; forceRotatedAt = now so this sweep skips it next\s*\n?\s*\/\/ {6}cycle\)\./,
    );
    expect(body).toMatch(
      /\/\/ {3}2\. Email the customer the new secret prefix \+ 7-day grace\s*\n?\s*\/\/ {6}deadline \(sub-slice 28\.4 template wiring lands separately;\s*\n?\s*\/\/ {6}this slice fires the existing rotation-reminder email shape\s*\n?\s*\/\/ {6}for now\)\./,
    );
  });

  it("7-day grace cross-slice integration framing pinned: 'The 7-day grace window is honoured by the v2-#20 worker via secret_prev / secret_prev_expires_at; v2-#29's cleanup nulls secret_prev past the grace deadline. Validation against incoming HMACs (sub-slice 28.3) reads graceWindowEndsAt as the cutoff.' — pinned so the v2-#20 dual-signing + v2-#29 cleanup + 28.3 HMAC-validation cross-references all stay documented (drift would silently break the dual-signing handoff)", () => {
    expect(body).toMatch(
      /\/\/ The 7-day grace window is honoured by the v2-#20 worker via\s*\n?\s*\/\/ secret_prev \/ secret_prev_expires_at; v2-#29's cleanup nulls\s*\n?\s*\/\/ secret_prev past the grace deadline\. Validation against incoming\s*\n?\s*\/\/ HMACs \(sub-slice 28\.3\) reads graceWindowEndsAt as the cutoff\./,
    );
  });

  it('3-constant catalog pinned: FORCE_ROTATE_THRESHOLD_DAYS=91 + GRACE_WINDOW_DAYS=7 + MS_PER_DAY. Drift to a different threshold would diverge from the Q1=B verdict; drift to a different grace would diverge from Q2=B', () => {
    expect(body).toMatch(/const FORCE_ROTATE_THRESHOLD_DAYS = 91;/);
    expect(body).toMatch(/const GRACE_WINDOW_DAYS = 7;/);
    expect(body).toMatch(/const MS_PER_DAY = 24 \* 60 \* 60 \* 1000;/);
  });

  it("v2-#36 dashboardUrl framing pinned: 'customer-facing dashboard origin. The reminder email links into the dashboard rotation-management view.' — pinned so the rotation-management-view cross-link contract stays documented", () => {
    expect(body).toMatch(
      /\/\*\* v2-#36 — customer-facing dashboard origin\. The reminder email\s*\n?\s*\*\s+links into the dashboard rotation-management view\. \*\//,
    );
    expect(body).toMatch(/dashboardUrl: string;/);
  });

  it('perTickLimit default 50 pinned (matches the rotation-reminder service for cohort-cron-bursts alignment)', () => {
    expect(body).toMatch(/this\.perTickLimit = config\.perTickLimit \?\? 50;/);
  });

  it('tickOnce 5-step force-rotation pipeline pinned: 1. findEndpointsNeedingForceRotation 2. for each: generateWebhookSecret + webhookSecretPrefix + graceWindowEndsAt computation 3. repo.forceRotateSecret (returns null if endpoint disappeared/disabled — skip email) 4. attempt sendWebhookSecretForceRotated email 5. log warning on no-accountEmail. Drift to skipping the null-return branch would crash on disappeared rows; drift to skipping forceRotateSecret on null-email would leave eligible rows in the sweep set forever', () => {
    expect(body).toMatch(
      /const newSecret = generateWebhookSecret\(\);\s*\n?\s*const newPrefix = webhookSecretPrefix\(newSecret\);\s*\n?\s*const graceWindowEndsAt = new Date\(now\.getTime\(\) \+ GRACE_WINDOW_DAYS \* MS_PER_DAY\);/,
    );
    expect(body).toMatch(
      /const updated: WebhookEndpointRow \| null = await this\.repo\.forceRotateSecret\(\{\s*\n?\s*id: ep\.id,\s*\n?\s*newSecret,\s*\n?\s*newPrefix,\s*\n?\s*graceWindowEndsAt,\s*\n?\s*now,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(updated === null\) \{\s*\n?\s*this\.logger\.warn\(\s*\n?\s*\{ endpointId: ep\.id, accountId: ep\.accountId \},\s*\n?\s*'force-rotation update returned no row \(endpoint disappeared \/ disabled\); skipping email',\s*\n?\s*\);\s*\n?\s*continue;\s*\n?\s*\}/,
    );
  });

  it('Arc 3 sub-slice 28.4 dedicated-template framing pinned: \'dedicated template distinguishes the force-rotation event from the 60-day reminder. Customer sees "we auto-rotated for security" framing instead of "rotate at your convenience".\' — pinned so the dedicated-template + tone-distinction (security-event vs. convenience-nudge) contract stays documented', () => {
    expect(body).toMatch(
      /\/\/ Arc 3 sub-slice 28\.4 \(v2-#28\) — dedicated template\s*\n?\s*\/\/ distinguishes the force-rotation event from the 60-day\s*\n?\s*\/\/ reminder\. Customer sees "we auto-rotated for security"\s*\n?\s*\/\/ framing instead of "rotate at your convenience"\./,
    );
  });

  it('sendWebhookSecretForceRotated 5-field call shape pinned: to + endpointUrl + newSecretPrefix + graceWindowEndsAt + dashboardUrl. Drift to dropping graceWindowEndsAt would leave customers without a deadline anchor for their verifier rollover; drift to dropping newSecretPrefix would force customers to log into the dashboard just to identify which key rotated', () => {
    expect(body).toMatch(
      /await this\.email\.sendWebhookSecretForceRotated\(\{\s*\n?\s*to: ep\.accountEmail,\s*\n?\s*endpointUrl: ep\.url,\s*\n?\s*newSecretPrefix: newPrefix,\s*\n?\s*graceWindowEndsAt,\s*\n?\s*dashboardUrl: this\.dashboardUrl,\s*\n?\s*\}\);/,
    );
  });

  it("Email-send-failure non-fatal + rotation-persisted log pinned: 'force-rotation email send failed (non-fatal); rotation persisted'. Drift to throwing would let a transient Postmark outage leave secrets rotated WITHOUT notifying — worse: it could fail to persist the rotation in some implementations. The current code rotates FIRST then attempts email so the rotation is durable regardless of email outcome", () => {
    expect(body).toMatch(/'force-rotation email send failed \(non-fatal\); rotation persisted',/);
  });

  it("No-accountEmail branch persists-rotation-without-notification log pinned: 'force-rotation: no accountEmail on record; rotation persisted without notification'. Drift to skipping the rotation when no email is set would defeat the security purpose — the rotation is mandatory at 91 days regardless of notification path", () => {
    expect(body).toMatch(
      /'force-rotation: no accountEmail on record; rotation persisted without notification',/,
    );
  });
});
