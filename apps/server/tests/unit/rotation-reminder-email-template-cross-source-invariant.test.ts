// Cross-source invariant: rotation-reminder email methods are
// defined on EmailService, consumed by the rotation-reminder
// services, AND documented by name in the customer-facing docs.
// Drift on the method name would orphan the docs from the actual
// trigger + break the typed-call-site contract.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const EMAIL = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');
const BYOK_REMINDER = resolve(
  REPO_ROOT,
  'apps/server/src/services/byok-anthropic-rotation-reminder.ts',
);
const WEBHOOK_REMINDER = resolve(
  REPO_ROOT,
  'apps/server/src/services/webhook-rotation-reminder.ts',
);
const DOCS_BYOK = resolve(REPO_ROOT, 'apps/docs/src/pages/api/byok-anthropic.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('rotation-reminder email-template cross-source invariant', () => {
  const email = read(EMAIL);
  const byokReminder = read(BYOK_REMINDER);
  const webhookReminder = read(WEBHOOK_REMINDER);
  const docs = read(DOCS_BYOK);

  it('EmailService declares sendByokAnthropicKeyRotationReminder + sendWebhookSecretRotationReminder method signatures', () => {
    expect(email).toMatch(/sendByokAnthropicKeyRotationReminder\(args: \{/);
    expect(email).toMatch(/sendWebhookSecretRotationReminder\(args: \{/);
  });

  it('EmailService no-op stub implements both rotation-reminder methods as async no-ops — pinned so test/dev mode keeps a non-throwing default', () => {
    expect(email).toMatch(/sendWebhookSecretRotationReminder: async \(\) => \{\},/);
    expect(email).toMatch(/sendByokAnthropicKeyRotationReminder: async \(\) => \{\},/);
  });

  it('byok-anthropic-rotation-reminder service calls email.sendByokAnthropicKeyRotationReminder — pinned so the typed call-site matches the EmailService interface (drift on method name would compile-fail)', () => {
    expect(byokReminder).toMatch(/await this\.email\.sendByokAnthropicKeyRotationReminder\(\{/);
  });

  it('webhook-rotation-reminder service calls email.sendWebhookSecretRotationReminder — pinned so the typed call-site matches the EmailService interface', () => {
    expect(webhookReminder).toMatch(/await this\.email\.sendWebhookSecretRotationReminder\(\{/);
  });

  it("docs/api/byok-anthropic.md customer-facing copy references the method by name: 'sendByokAnthropicKeyRotationReminder' — pinned so the docs cross-reference stays in sync with the EmailService method name (drift would orphan the customer-facing trigger documentation from the actual Postmark send)", () => {
    expect(docs).toMatch(/`sendByokAnthropicKeyRotationReminder`/);
  });
});
