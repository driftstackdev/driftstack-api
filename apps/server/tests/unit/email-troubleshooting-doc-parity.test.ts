// W235.A — drift-guard for /docs/email-troubleshooting.
// Pins the magic-link expiry claim to AUTH_TOKEN_TTL_MS.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_TOKEN_TTL_MS } from '../../src/lib/auth-tokens.js';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'email-troubleshooting.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W235.A email-troubleshooting doc parity', () => {
  const doc = read(DOC_PATH);

  it('magic-link expiry claim matches AUTH_TOKEN_TTL_MS.magicLink', () => {
    const minutes = AUTH_TOKEN_TTL_MS.magicLink / 60_000;
    expect(minutes).toBe(15);
    expect(doc).toMatch(new RegExp(`expire after ${minutes} minutes`));
  });
});
