import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const body = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md'), 'utf8');

describe('/webhooks/events live detail coverage', () => {
  for (const event of [
    'session.completed',
    'session.failed',
    'api_key.revoked',
    'test.ping',
    'session.egress_capability_changed',
    'crypto.order.paid',
    'crypto.order.failed',
    'session.challenge_detected',
    'session.profile_save_failed',
  ]) {
    it(`documents ${event}`, () => {
      expect(body).toContain(`### \`${event}\``);
    });
  }

  it('contains no aspirational event status or silent quota subscription', () => {
    expect(body).not.toMatch(/\[(?:LIVE|DECLARED|PLANNED)\]/);
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded|Planned events/);
  });
});
