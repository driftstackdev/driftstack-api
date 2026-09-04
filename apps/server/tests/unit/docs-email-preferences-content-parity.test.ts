// Drift guard for apps/docs/src/pages/api/email-preferences.md.
// Pins the operational-vs-transactional category split + the 8
// opt-outable event types so a future refactor can't accidentally
// drop or rename a category without tripping the guard.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/email-preferences.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/email-preferences content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Email preferences/);
    expect(body).toMatch(/description: Manage which transactional emails Driftstack sends/);
  });

  it('operational-vs-transactional category split pinned (operational MUST stay non-optional; drift to "opt out of operational" would create real customer-impact failure modes — missed billing-failure notices etc.)', () => {
    expect(body).toMatch(/\*\*Operational\*\* — non-optional/);
    expect(body).toMatch(/You cannot opt out of these\./);
    expect(body).toMatch(/\*\*Transactional \/ informational\*\* — opt-outable/);
  });

  it('DPA-anchored affirmative-opt-out posture pinned (drift to a bulk "opt out of everything" toggle would violate the GDPR Article 21(2) right-to-object framing the DPA references)', () => {
    expect(body).toMatch(/Per-event opt-in is the unit/);
    expect(body).toMatch(/\[DPA\]\(https:\/\/driftstack\.io\/legal\/dpa\/\)/);
    expect(body).not.toMatch(/\[DPA\]\(https:\/\/driftstack\.io\/legal\/dpa\)/);
    expect(body).toMatch(/affirmative customer choice/);
  });

  it('6 opt-outable event types pinned (drift to dropping any would silently remove customer control over that mail type; the trial-pack pair was removed with the dead trial_pack lifecycle)', () => {
    for (const eventType of [
      'signup-welcome',
      'session-success-first',
      'session-failed-first',
      'tier-changed',
      'billing-receipt',
      'billing-renewal-reminder',
    ]) {
      expect(body, `event_type ${eventType}`).toContain(`"event_type": "${eventType}"`);
    }
    expect(body).not.toContain('"event_type": "trial-pack-purchased"');
    expect(body).not.toContain('"event_type": "trial-pack-expired"');
  });

  it('Team RBAC framing pinned (member-AND-admin read access on owner preferences)', () => {
    expect(body).toMatch(/Team RBAC/);
    expect(body).toMatch(/X-Driftstack-Account: acc_<owner-uuid>/);
    expect(body).toMatch(/Both `member` and `admin` roles are allowed for the read\./);
  });
});
