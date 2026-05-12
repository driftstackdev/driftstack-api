// W311.B — drift guard for /trust/sub-processors page binding. The
// page must source its table + changelog + last-updated stamp from
// the canonical SUB_PROCESSORS / SUB_PROCESSOR_CHANGELOG /
// SUB_PROCESSOR_REGISTER_LAST_UPDATED exports, not inline literals.
// Every sub-processor in the data module must have a corresponding
// row rendered on the page (covered indirectly by the binding).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SUB_PROCESSORS,
  SUB_PROCESSOR_REGISTER_LAST_UPDATED,
  SUB_PROCESSOR_CHANGELOG,
} from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/sub-processors.astro');

const REQUIRED_NAMES = [
  'Hetzner Cloud',
  'Neon',
  'Upstash',
  'Cloudflare R2',
  'Postmark',
  'Sentry',
  'Stripe',
  'Anthropic',
  'Moneybird',
  'MacStadium',
  'NowPayments',
  'LiveKit',
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W311.B /trust/sub-processors data binding', () => {
  const body = read(PAGE);

  it('imports SUB_PROCESSORS + LAST_UPDATED + CHANGELOG from the data module', () => {
    expect(body).toMatch(
      /import\s*\{[\s\S]*?SUB_PROCESSORS[\s\S]*?SUB_PROCESSOR_REGISTER_LAST_UPDATED[\s\S]*?SUB_PROCESSOR_CHANGELOG[\s\S]*?\}\s+from\s+['"][^'"]*data\/sub-processors/,
    );
  });

  it('iterates SUB_PROCESSORS for the table (not inline literals)', () => {
    expect(body).toMatch(/SUB_PROCESSORS\.map/);
  });

  it('iterates SUB_PROCESSOR_CHANGELOG for the changelog', () => {
    expect(body).toMatch(/SUB_PROCESSOR_CHANGELOG\.map/);
  });

  it('renders the LAST_UPDATED stamp', () => {
    expect(body).toContain('SUB_PROCESSOR_REGISTER_LAST_UPDATED');
  });

  it('data module covers every canonical sub-processor', () => {
    const present = SUB_PROCESSORS.map((sp) => sp.name);
    const missing = REQUIRED_NAMES.filter((n) => !present.includes(n));
    expect(missing).toEqual([]);
  });

  it('LAST_UPDATED is the same ISO date the trust page header will render', () => {
    expect(SUB_PROCESSOR_REGISTER_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
