// Drift guard for apps/server/src/db/byok-anthropic-rotation-reminder-repo.ts.
// Pins v2-#11.5 Drizzle-backed ByokAnthropicRotationReminderRepo. Queries
// accounts whose BYOK key is older than threshold AND hasn't been
// reminded within the cooldown window. Mirrors the webhook-rotation
// pattern (v2-#10.5).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/byok-anthropic-rotation-reminder-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/byok-anthropic-rotation-reminder-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("v2-#11.5 module-level framing pinned: 'Drizzle-backed ByokAnthropicRotationReminderRepo. Queries accounts whose BYOK Anthropic API key is older than the threshold AND hasn't been reminded in the cooldown window. Mirrors the webhook-rotation pattern (v2-#10.5).' — pinned so the v2-#11.5 anchor + threshold+cooldown predicate + webhook-rotation-pattern cross-reference (v2-#10.5) contract all stay documented", () => {
    expect(body).toMatch(/\/\/ v2-#11\.5 — Drizzle-backed ByokAnthropicRotationReminderRepo\./);
    expect(body).toMatch(
      /\/\/ Queries accounts whose BYOK Anthropic API key is older than the\s*\/\/ threshold AND hasn't been reminded in the cooldown window\. Mirrors\s*\/\/ the webhook-rotation pattern \(v2-#10\.5\)\./,
    );
  });

  it('MS_PER_DAY = 24 * 60 * 60 * 1000 constant pinned. Drift to a different multiplier would silently shift the threshold + cooldown windows by the same multiplicative factor (a 25h-day would push reminders almost a year past intent)', () => {
    expect(body).toMatch(/const MS_PER_DAY = 24 \* 60 \* 60 \* 1000;/);
  });

  it("findAccountsNeedingRotationReminder 3-predicate WHERE pinned: BYOK key set (not null) + key age > threshold + (never reminded OR last reminder older than cooldown). + 'BYOK key must be set (otherwise there's nothing to rotate).' + 'Key age exceeds threshold.' + 'Dedupe: never reminded or last reminder older than cooldown.' — pinned so the 3-predicate roster + dedupe contract stays documented (drift to dropping the never-reminded branch would suppress the very first reminder cycle for a fresh BYOK key past the threshold)", () => {
    expect(body).toMatch(
      /\/\/ BYOK key must be set \(otherwise there's nothing to rotate\)\.\s*not\(isNull\(accounts\.byokAnthropicApiKeySetAt\)\),\s*\/\/ Key age exceeds threshold\.\s*lt\(accounts\.byokAnthropicApiKeySetAt, thresholdCutoff\),\s*\/\/ Dedupe: never reminded or last reminder older than cooldown\.\s*or\(\s*isNull\(accounts\.byokAnthropicApiKeyLastReminderSentAt\),\s*lt\(accounts\.byokAnthropicApiKeyLastReminderSentAt, cooldownCutoff\),\s*\),/,
    );
  });

  it('thresholdCutoff + cooldownCutoff math pinned: new Date(args.now.getTime() - args.thresholdDays * MS_PER_DAY) + new Date(args.now.getTime() - args.cooldownDays * MS_PER_DAY). Drift to subtracting cooldown on threshold (or vice versa) would silently swap the windows and misroute reminders', () => {
    expect(body).toMatch(
      /const thresholdCutoff = new Date\(args\.now\.getTime\(\) - args\.thresholdDays \* MS_PER_DAY\);\s*const cooldownCutoff = new Date\(args\.now\.getTime\(\) - args\.cooldownDays \* MS_PER_DAY\);/,
    );
  });

  it('orderBy oldest-first + limit framing pinned: .orderBy(byokAnthropicApiKeySetAt) ASC + .limit(args.limit). Drift to ordering by lastReminderSentAt would prioritize recently-reminded accounts over the never-reminded oldest-key accounts (defeating the dedupe contract)', () => {
    expect(body).toMatch(
      /\.orderBy\(accounts\.byokAnthropicApiKeySetAt\)\s*\.limit\(args\.limit\);/,
    );
  });

  it('Post-SELECT type-narrowing filter pinned: filter(r): r is typeof r & { byokAnthropicApiKeySetAt: Date } guard with r.byokAnthropicApiKeySetAt !== null narrowing. Drift to dropping the type guard would surface possibly-null setAt to downstream consumers via the TS inference path', () => {
    expect(body).toMatch(
      /\.filter\(\s*\(r\): r is typeof r & \{ byokAnthropicApiKeySetAt: Date \} =>\s*r\.byokAnthropicApiKeySetAt !== null,\s*\)/,
    );
  });

  it("markReminderSent updates ONLY byokAnthropicApiKeyLastReminderSentAt framing pinned: .set({ byokAnthropicApiKeyLastReminderSentAt: args.now }). Drift to also bumping updatedAt would create artificial 'customer mutated' signals in the audit log; drift to clearing the existing reminder cycle would loop reminders into infinity", () => {
    expect(body).toMatch(
      /async markReminderSent\(args: \{ accountId: string; now: Date \}\): Promise<void> \{\s*await this\.database\.db\s*\.update\(accounts\)\s*\.set\(\{ byokAnthropicApiKeyLastReminderSentAt: args\.now \}\)\s*\.where\(eq\(accounts\.id, args\.accountId\)\);/,
    );
  });
});
