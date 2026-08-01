// W284.A — drift guard for privacy policy sub-processor coverage.
// Every entry in apps/marketing-site/src/data/sub-processors.ts
// must be mentioned by name in apps/marketing-site/src/pages/
// legal/privacy.md so the privacy policy and DPA stay in sync.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS } from '../../src/data/sub-processors';
import { unnamedIn } from './_sub-processor-matching';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PRIVACY = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/privacy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * The sub-processors we disclose, pinned exactly.
 *
 * Exact rather than a count, and here rather than derived from the data file,
 * because both directions are events that require action. Adding a
 * sub-processor obliges us to update this policy, the DPA Annex 3 table and to
 * notify customers under GDPR Art. 28(2); removing one means the disclosure now
 * overstates who touches customer data. Either way a human should have to
 * change this line, so neither can happen as a silent side effect of editing a
 * data file.
 */
const EXPECTED_SUB_PROCESSORS = [
  'Anthropic',
  'Cloudflare R2',
  'Hetzner Cloud',
  'LiveKit',
  'MacStadium',
  'Moneybird',
  'Neon',
  'NowPayments',
  'Postmark',
  'Sentry',
  'Stripe',
  'Upstash',
];

describe('W284.A SUB_PROCESSORS ↔ legal/privacy.md parity', () => {
  const privacy = read(PRIVACY);

  it('CRITICAL the roster is non-empty and matches what we expect to disclose, and the matcher still reports a name the policy omits. The assertion below reports an ABSENCE of missing entries, so an empty or shortened SUB_PROCESSORS makes it true while the policy silently stops naming somebody who processes customer data — which is the disclosure this exists to guarantee.', () => {
    expect([...SUB_PROCESSORS.map((sp) => sp.name)].sort()).toEqual(EXPECTED_SUB_PROCESSORS);
    expect(
      unnamedIn(privacy, ['Definitely Not A Real Sub-Processor']),
      'a name the policy does not contain is reported by the same matcher used below',
    ).toEqual(['Definitely Not A Real Sub-Processor']);
  });

  it('every SUB_PROCESSORS entry is named in the privacy policy table', () => {
    expect(
      unnamedIn(
        privacy,
        SUB_PROCESSORS.map((sp) => sp.name),
      ),
    ).toEqual([]);
  });
});
