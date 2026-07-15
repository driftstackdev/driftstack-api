// Drift guard for apps/server/src/db/webhook-rotation-reminder-repo.ts.
// Pins v2-#10.5 Drizzle-backed WebhookRotationReminderRepo — the
// joined webhook_endpoints + accounts shape for the reminder sweep.
// `now - thresholdDays` filters secret age; `now - cooldownDays`
// filters dedupe.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/webhook-rotation-reminder-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/webhook-rotation-reminder-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("v2-#10.5 module-level framing pinned: 'Drizzle-backed WebhookRotationReminderRepo. Queries the joined webhook_endpoints + accounts shape for the reminder sweep. now - thresholdDays filters the secret age; now - cooldownDays filters the dedupe column.' — pinned so the v2-#10.5 anchor + joined-webhook_endpoints+accounts + 2-cutoff-predicate contract all stay documented", () => {
    expect(body).toMatch(/\/\/ v2-#10\.5 — Drizzle-backed WebhookRotationReminderRepo\./);
    expect(body).toMatch(
      /\/\/ Queries the joined webhook_endpoints \+ accounts shape for the\s*\n?\s*\/\/ reminder sweep\. `now - thresholdDays` filters the secret age;\s*\n?\s*\/\/ `now - cooldownDays` filters the dedupe column\./,
    );
  });

  it('MS_PER_DAY = 24 * 60 * 60 * 1000 constant pinned. Symmetric with byok-anthropic-rotation-reminder-repo.ts (same pattern v2-#10.5 → v2-#11.5 mirror)', () => {
    expect(body).toMatch(/const MS_PER_DAY = 24 \* 60 \* 60 \* 1000;/);
  });

  it("findEndpointsNeedingRotationReminder 3-predicate WHERE pinned: disabledAt IS NULL (skip tombstones) + secretCreatedAt < thresholdCutoff (age exceeds) + (never reminded OR last reminder older than cooldown). + 'Disabled endpoints are tombstones; skip them.' + 'Active-secret age exceeds the threshold.' + 'Dedupe: either never reminded or last reminder older than cooldown.' — pinned so the 3-predicate roster + tombstone-skip-via-disabledAt-null + dedupe contract all stay documented (drift to dropping the tombstone-skip would surface reminders for cleared endpoints)", () => {
    expect(body).toMatch(
      /\/\/ Disabled endpoints are tombstones; skip them\.\s*\n?\s*isNull\(webhookEndpoints\.disabledAt\),\s*\n?\s*\/\/ Active-secret age exceeds the threshold\.\s*\n?\s*lt\(webhookEndpoints\.secretCreatedAt, thresholdCutoff\),\s*\n?\s*\/\/ Dedupe: either never reminded or last reminder older than\s*\n?\s*\/\/ cooldown\.\s*\n?\s*or\(\s*\n?\s*isNull\(webhookEndpoints\.lastReminderSentAt\),\s*\n?\s*lt\(webhookEndpoints\.lastReminderSentAt, cooldownCutoff\),\s*\n?\s*\),/,
    );
  });

  it("Inner-join accounts framing pinned: .innerJoin(accounts, eq(accounts.id, webhookEndpoints.accountId)) + select accountEmail: accounts.email. Drift to dropping the join would lose the customer's email for the reminder dispatch", () => {
    expect(body).toMatch(
      /\.innerJoin\(accounts, eq\(accounts\.id, webhookEndpoints\.accountId\)\)/,
    );
    expect(body).toMatch(/accountEmail: accounts\.email,/);
  });

  it('orderBy oldest-secret-first + limit framing pinned: .orderBy(webhookEndpoints.secretCreatedAt) ASC + .limit(args.limit). Drift to ordering by lastReminderSentAt would re-prioritize already-reminded over never-reminded oldest secrets (defeating dedupe intent)', () => {
    expect(body).toMatch(
      /\.orderBy\(webhookEndpoints\.secretCreatedAt\)\s*\n?\s*\.limit\(args\.limit\);/,
    );
  });

  it('the joined materializer binds both secret slots to the selected account+endpoint tuple and fails clearly without a key', () => {
    expect(body).toMatch(/secretPrev: webhookEndpoints\.secretPrev,/);
    expect(body).toMatch(/secretPrevExpiresAt: webhookEndpoints\.secretPrevExpiresAt,/);
    expect(body).toMatch(/graceWindowEndsAt: webhookEndpoints\.graceWindowEndsAt,/);
    expect(body).toMatch(/forceRotatedAt: webhookEndpoints\.forceRotatedAt,/);
    expect(body).toMatch(/consecutiveFailures: webhookEndpoints\.consecutiveFailures,/);
    expect(body).toMatch(
      /private requireEncryptionKey\(\): string \{[\s\S]*?Webhook secret encryption key is unavailable/,
    );
    expect(body).toMatch(
      /secret: readWebhookSecret\(r\.secret, this\.requireEncryptionKey\(\), \{\s*\n?\s*accountId: r\.accountId,\s*\n?\s*endpointId: r\.id,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /readWebhookSecret\(r\.secretPrev, this\.requireEncryptionKey\(\), \{\s*\n?\s*accountId: r\.accountId,\s*\n?\s*endpointId: r\.id,\s*\n?\s*\}\)/,
    );
  });

  it("markReminderSent updates ONLY lastReminderSentAt framing pinned: .set({ lastReminderSentAt: args.now }) + void sql to suppress unused-import warn. Drift to bumping updatedAt would create artificial 'customer mutated' signals on every reminder cycle (vs the actual customer-driven mutation events)", () => {
    expect(body).toMatch(
      /async markReminderSent\(args: \{ endpointId: string; now: Date \}\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(webhookEndpoints\)\s*\n?\s*\.set\(\{ lastReminderSentAt: args\.now \}\)\s*\n?\s*\.where\(eq\(webhookEndpoints\.id, args\.endpointId\)\);\s*\n?\s*\/\/ sql import kept for future predicate work; suppress unused import warn\.\s*\n?\s*void sql;/,
    );
  });
});
