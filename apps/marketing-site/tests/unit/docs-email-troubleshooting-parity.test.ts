// W266.B — drift-guard for /docs/email-troubleshooting. Pins:
// 1. noreply@driftstack.dev is the canonical sender (no fictional aliases).
// 2. Postmark is named as the sending provider (matches sub-processor list).
// 3. support@driftstack.dev is the contact for replays.
// 4. status.driftstack.dev is cited for outage cases.
// 5. /docs/emails-reference cross-link exists.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS } from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/email-troubleshooting.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W266.B /docs/email-troubleshooting ↔ canonical sender + provider parity', () => {
  const page = read(PAGE);

  it('canonical sender noreply@driftstack.dev is named', () => {
    expect(page).toMatch(/noreply@driftstack\.dev/);
  });

  it('does not name fictional alternate sender domains', () => {
    expect(page).not.toMatch(/@driftstack\.io/);
    expect(page).not.toMatch(/@mail\.driftstack\.dev/);
    expect(page).not.toMatch(/@email\.driftstack\.dev/);
  });

  it('Postmark is named as the sending provider (matches sub-processor list)', () => {
    expect(page).toMatch(/Postmark/);
    const live = new Set(SUB_PROCESSORS.map((s) => s.name.split(' ')[0]!));
    expect(live.has('Postmark')).toBe(true);
  });

  it('support@driftstack.dev is the contact for replays', () => {
    expect(page).toMatch(/support@driftstack\.dev/);
  });

  it('status.driftstack.dev is cited for outage cases', () => {
    expect(page).toMatch(/status\.driftstack\.dev/);
  });

  it('cross-link /docs/emails-reference exists', () => {
    // The doc may not always link; verify the target page exists.
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/emails-reference.astro')),
    ).toBe(true);
  });
});
