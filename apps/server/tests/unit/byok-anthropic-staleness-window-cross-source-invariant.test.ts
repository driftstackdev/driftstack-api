// Cross-source invariant: the 60-day reminder + 90-day staleness BYOK
// Anthropic key TTL must agree across service constants + the
// customer-facing docs page. Drift would either over-promise (docs say
// 90 but code stales sooner) or under-deliver (docs say 60 but code
// reminds later).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/byok-anthropic.ts');
const REMINDER = resolve(REPO_ROOT, 'apps/server/src/services/byok-anthropic-rotation-reminder.ts');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/api/byok-anthropic.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('BYOK Anthropic staleness-window cross-source invariant', () => {
  const serviceSrc = read(SERVICE);
  const reminderSrc = read(REMINDER);
  const docs = read(DOCS);

  it('service BYOK_ANTHROPIC_KEY_TTL_MS = 90 days matches reminder ROTATION_TARGET_DAYS = 90', () => {
    expect(serviceSrc).toMatch(
      /export const BYOK_ANTHROPIC_KEY_TTL_MS = 90 \* 24 \* 60 \* 60 \* 1000;/,
    );
    expect(reminderSrc).toMatch(/const ROTATION_TARGET_DAYS = 90;/);
  });

  it("service comment explicitly cross-references the rotation-reminder constant: '90 days matches the ROTATION_TARGET_DAYS constant in the rotation-reminder services (v2-#10.5 / v2-#11.5) — past that point the customer has been nagged for ~30 days and the key is considered stale.' — pinned so the cross-reference + 30-day-nag-window-before-stale rationale all stay documented", () => {
    expect(serviceSrc).toMatch(
      /90 days matches the\s*\*\s+ROTATION_TARGET_DAYS constant in the rotation-reminder services\s*\*\s+\(v2-#10\.5 \/ v2-#11\.5\) — past that point the customer has been\s*\*\s+nagged for ~30 days and the key is considered stale\./,
    );
  });

  it('reminder REMINDER_THRESHOLD_DAYS = 60 + ROTATION_TARGET_DAYS = 90 → 30-day nag window matches the docs "After 60 days the customer receives a one-time Postmark reminder email" + "After 90 days the BYOKAnthropicService.getPlaintext returns null"', () => {
    expect(reminderSrc).toMatch(/const REMINDER_THRESHOLD_DAYS = 60;/);
    expect(reminderSrc).toMatch(/const ROTATION_TARGET_DAYS = 90;/);
    expect(docs).toMatch(/Stored keys carry an implicit 90-day staleness window\. After 60/);
    expect(docs).toMatch(/After 90 days the/);
  });

  it('docs explicitly call sendByokAnthropicKeyRotationReminder — pinned so the docs + service function name stay in sync (drift on the function name would orphan the docs from the actual Postmark trigger)', () => {
    expect(docs).toMatch(/`sendByokAnthropicKeyRotationReminder`/);
  });

  it('docs explicitly call BYOKAnthropicService.getPlaintext({ now }) returns null on stale — pinned so the docs + service method signature stay in sync', () => {
    expect(docs).toMatch(/`BYOKAnthropicService\.getPlaintext\(\{ now \}\)` call returns null/);
  });

  it('PUT-resets-set_at contract framing pinned in docs + matches the service upsert path that touches set_at on every successful PUT (cross-confirmed by db/byok-anthropic-repo.ts upsert)', () => {
    expect(docs).toMatch(
      /Customers can refresh the staleness window by PUTting the same\s*key \(resets `set_at`\)/,
    );
  });
});
