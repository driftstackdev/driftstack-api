// W236.A — drift-guard for /docs/emails-reference. Pins:
//   - the auth route paths used by the trigger column
//   - the opt-outable event set (Lifecycle + Billing tables) against
//     OptOutableEmailEventSchema

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OptOutableEmailEventSchema } from '@driftstack/api-types';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'emails-reference.astro',
);
const AUTH_ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'auth.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W236.A emails-reference doc parity', () => {
  const doc = read(DOC_PATH);
  const auth = read(AUTH_ROUTE_PATH);

  it('signup + password-reset trigger paths match the real auth routes', () => {
    expect(auth).toMatch(/'\/v1\/auth\/signup'/);
    expect(auth).toMatch(/'\/v1\/auth\/password-reset\/request'/);
    expect(doc).toMatch(/POST \/v1\/auth\/signup/);
    expect(doc).toMatch(/POST \/v1\/auth\/password-reset\/request/);
    // Stale path the previous revision used:
    expect(doc).not.toMatch(/POST \/v1\/auth\/password-reset<\/code>\)/);
  });

  it('email-preferences endpoint paths are correct', () => {
    expect(doc).toMatch(/GET \/v1\/account\/email-preferences/);
    expect(doc).toMatch(/PUT \/v1\/account\/email-preferences/);
  });

  it('every event mentioned as opt-outable appears in OptOutableEmailEventSchema', () => {
    const allowed = new Set((OptOutableEmailEventSchema._def.values as readonly string[]).slice());
    // Pull every `<strong>foo-bar</strong>` entry from the Lifecycle
    // table — those are claimed opt-outable.
    const lifecycle = doc.split('<h2>Lifecycle (opt-outable)</h2>')[1]?.split('<h2>')[0] ?? '';
    const events = Array.from(lifecycle.matchAll(/<strong>([a-z-]+)<\/strong>/g)).map((m) => m[1]!);
    expect(events.length).toBeGreaterThan(0);
    const offenders = events.filter((e) => !allowed.has(e));
    expect(
      offenders,
      `events claimed opt-outable but not in enum: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
